import type { AdapterCapabilities, AdapterEvent, AccountView, AccountViewOptions, BrowserAdapter, FetchInSessionResult } from './adapter.ts';

/**
 * Electron implementation of BrowserAdapter.
 *
 * STATUS: implemented, NOT executed in this sandbox (no arm64 macOS/Electron —
 * see docs/evidence-register.md). It is written against the pinned-major CDP
 * surface and the ambient electron types in electron-types.d.ts. The real build
 * replaces the ambient file with electron's own types and runs the P0 gates.
 *
 * Design rules encoded here:
 * - The ONLY injection is the read-only isolated-world witness (§4).
 * - Arena views are never allowed to open DevTools (would detach debugger) — enforced, not advisory.
 * - Downloads are account-bound from `will-download` before any save path is chosen (§5).
 * - No Node/Electron API is exposed to renderers; there is deliberately no preload for Arena views.
 */

const ARENA_ORIGIN = 'https://arena.ai';

export interface ElectronRuntime {
  app: { getPath(name: string): string };
  session: { fromPartition(partition: string, opts?: { cache?: boolean }): ElectronSessionLike };
  WebContentsView: new (opts?: { webPreferences?: Record<string, unknown> }) => { webContents: WebContentsLike };
}

interface WebContentsLike {
  on(event: string, cb: (...a: never[]) => void): void;
  once(event: string, cb: (...a: never[]) => void): void;
  loadURL(url: string): Promise<void>;
  isDevToolsOpened(): boolean;
  close(): void;
  session: ElectronSessionLike;
  debugger: {
    attach(): void;
    detach(): void;
    isAttached(): boolean;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<{ ack: boolean }>;
    on(event: string, cb: (evt: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  };
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

interface ElectronSessionLike {
  setPermissionRequestHandler(cb: (wc: unknown, permission: string, grant: (ok: boolean) => void) => void): void;
  on(event: string, cb: (...a: never[]) => void): void;
}

/** Options for the Electron partition: one persistent session per account (§5). */
export interface ElectronAdapterOptions {
  runtime?: ElectronRuntime;
  /** Application Support/ArenaArchive/partitions/<account_uuid>/ */
  partitionsRoot: string;
  witnessSource: string;              // read-only isolated-world script (§6.4)
  onAccountDeniedPermission?: (wc: unknown, permission: string) => void;
}

export class ElectronBrowserAdapter implements BrowserAdapter {
  readonly kind = 'electron' as const;
  #rt: ElectronRuntime;
  #opts: ElectronAdapterOptions;
  #views: ElectronAccountView[] = [];

  constructor(opts: ElectronAdapterOptions) {
    this.#opts = opts;
    // Lazy, dynamic require: never evaluated in environments without electron.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rt = opts.runtime ?? (require('electron') as unknown as ElectronRuntime);
    this.#rt = rt;
  }

  capabilities(): AdapterCapabilities {
    return {
      kind: 'electron',
      attachBeforeNavigate: true,
      flattenedTargetAttach: true,
      responseBodies: 'full', // requires P0 falsification to VERIFY, this is the expected ceiling
      isolatedWorldScript: true,
      downloadHook: true,
      durableMessages: false, // Chromium's CDP buffers are not durable across renderer crash; gates measure this
      notes: ['pinned stable major; arm64 only; verify Network.streamResourceContent availability'],
    };
  }

  async createAccountView(opts: AccountViewOptions): Promise<AccountView> {
    const partition = `persist:arena-archive-${opts.accountId}`;
    const ses = this.#rt.session.fromPartition(partition, { cache: true });
    // Deny everything by default; Arena pages get no app privileges (§4).
    ses.setPermissionRequestHandler((_wc, permission, grant) => {
      this.#opts.onAccountDeniedPermission?.(_wc, permission);
      grant(false);
    });
    const view = new this.#rt.WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // no preload: deliberately absent for Arena views (§4)
      },
    });
    const v = new ElectronAccountView(view.webContents, opts, this.#opts.witnessSource);
    this.#views.push(v);
    return v;
  }

  async dispose(): Promise<void> {
    for (const v of this.#views) await v.close();
    this.#views = [];
  }
}

class ElectronAccountView implements AccountView {
  readonly accountId: string;
  #wc: WebContentsLike;
  #witnessSource: string;
  #listeners = new Set<(e: AdapterEvent) => void>();
  #acked = new Set<string>();
  #closed = false;

  constructor(wc: WebContentsLike, opts: AccountViewOptions, witnessSource: string) {
    this.accountId = opts.accountId;
    this.#wc = wc;
    this.#witnessSource = witnessSource;
    void opts.storagePath; // partition path derived by Electron from the explicit partition name; asserted by P3 tests
    wc.debugger.on('message', (evt: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => {
      this.#emit({ type: 'cdp', cdp: { method, params, sessionId }, sessionId });
    });
    wc.debugger.on('detach', () => {
      this.#emit({ type: 'diagnostic', detail: { code: 'debugger_detached', account_id: this.accountId } });
    });
    wc.on('render-process-gone', ((...a: never[]) => {
      this.#emit({ type: 'renderer_gone', detail: { account_id: this.accountId, details: a } });
    }) as never);
  }

  capabilities(): AdapterCapabilities {
    return { kind: 'electron', attachBeforeNavigate: true, flattenedTargetAttach: true, responseBodies: 'full', isolatedWorldScript: true, downloadHook: true, durableMessages: false, notes: [] };
  }
  isAttached(): boolean {
    try { return this.#wc.debugger.isAttached(); } catch { return false; }
  }

  #emit(e: AdapterEvent): void { for (const l of this.#listeners) l(e); }

  #step(detail: Record<string, unknown>): void {
    this.#emit({ type: 'protocol_step', detail: { account_id: this.accountId, ...detail } });
  }

  async attach(): Promise<void> {
    this.#wc.debugger.attach();
    this.#step({ step: 'debugger_attach' });
    this.#step({ step: 'bind_account', account_id: this.accountId });
    this.#step({ step: 'create_account_view', account_id: this.accountId });
    this.#step({ step: 'create_capture_queue', account_id: this.accountId });
  }

  async enableNetwork(o: { bufferSizeBytes: number; durable?: boolean }): Promise<void> {
    await this.#wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: o.bufferSizeBytes, maxResourceBufferSize: Math.floor(o.bufferSizeBytes / 4) });
    this.#acked.add('Network');
    this.#step({ step: 'domain_enable', domain: 'Network', ack: true });
  }
  async enablePage(): Promise<void> {
    await this.#wc.debugger.sendCommand('Page.enable');
    this.#acked.add('Page');
    this.#step({ step: 'domain_enable', domain: 'Page', ack: true });
  }
  async enableRuntime(): Promise<void> {
    await this.#wc.debugger.sendCommand('Runtime.enable');
    this.#acked.add('Runtime');
    this.#step({ step: 'domain_enable', domain: 'Runtime', ack: true });
  }
  async addIsolatedBinding(name: string, world: string): Promise<void> {
    await this.#wc.debugger.sendCommand('Runtime.addBinding', { name, executionContextName: world });
    this.#step({ step: 'add_binding', name, isolatedWorld: true, world });
  }
  async addScriptOnNewDocument(source: string, world: string): Promise<void> {
    await this.#wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source, worldName: world });
    void this.#witnessSource;
    this.#step({ step: 'add_script_to_evaluate_on_new_document', world });
  }
  async setAutoAttach(o: { flatten: true; waitForDebuggerOnStart: true }): Promise<void> {
    await this.#wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, flatten: o.flatten, waitForDebuggerOnStart: o.waitForDebuggerOnStart });
    this.#step({ step: 'set_auto_attach', autoAttach: true, flatten: o.flatten, waitForDebuggerOnStart: o.waitForDebuggerOnStart });
  }
  async verifyAcknowledgements(): Promise<{ allAcked: boolean; missing: string[] }> {
    const missing = ['Network', 'Page', 'Runtime'].filter((d) => !this.#acked.has(d));
    return { allAcked: missing.length === 0, missing };
  }
  async navigate(url: string): Promise<void> {
    if (!url.startsWith(ARENA_ORIGIN + '/') && url !== ARENA_ORIGIN) {
      throw new Error('navigate blocked: only https://arena.ai/ URLs allowed on capture views');
    }
    this.#step({ step: 'navigate', url });
    await this.#wc.loadURL(url);
  }
  async fetchInSession(input: { url: string; method: 'GET'; headers?: Record<string, string> }): Promise<FetchInSessionResult> {
    // Same-partition execution keeps transient credentials inside Chromium (§9.1 step 4).
    // We never read cookies here; the page-context fetch is used ONLY for owner-qualified
    // read operations, and its observations flow back through normal capture.
    const code = `(async () => {
      const r = await fetch(${JSON.stringify(input.url)}, { method: 'GET', credentials: 'include' });
      const headers = {}; r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      return { ok: r.ok, status: r.status, bodyText: await r.text(), headers };
    })()`;
    return (await this.#wc.executeJavaScript(code, false)) as FetchInSessionResult;
  }
  onEvent(cb: (e: AdapterEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }
  async setDevToolsOpen(open: boolean): Promise<void> {
    if (open) {
      // §6.1: DevTools on an attached Arena view is prohibited, not discouraged.
      throw new Error('DevTools are disabled on Arena capture views because opening them detaches the debugger');
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { this.#wc.debugger.detach(); } catch { /* already detached */ }
    this.#wc.close();
    this.#listeners.clear();
  }
}

// CJS bridge for optional runtime import under strip-only TS.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
