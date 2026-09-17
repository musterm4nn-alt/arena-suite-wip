import { createHash } from 'node:crypto';
import type { AdapterCapabilities, AdapterEvent, AccountView, AccountViewOptions, BrowserAdapter, FetchInSessionResult } from './adapter.ts';
import type { ProtocolStep, ProtocolStepInput } from '@arena/capture-core';
import type { CompletenessState } from '@arena/schema';

/**
 * Mock adapter: the hostile sparring partner used by every headless gate.
 * It is deliberately *deterministic* (seeded) and can reproduce the exact
 * failure classes P0 lists (§15): worker/SW target churn, navigation during
 * streams, renderer loss mid-stream, arbitrary UTF-8/logical splits,
 * duplicate replays, queue overflow, two-account interference, WS/SSE/RSC
 * transports, partial/stopped/failed outcomes, downloads.
 *
 * It models Chromium CDP *semantics as documented*, not Arena's actual
 * traffic — see docs/evidence-register.md for what this does and does not prove.
 */

export interface StreamScript {
  requestId: string;
  url: string;
  method: 'GET' | 'POST';
  /** body as the full logical bytes; the adapter splits them adversarially */
  body: string | Uint8Array;
  chunkSize?: number;             // fixed split size; 0/undefined => seed-random 1..13
  duplicateChunks?: number[];     // seq indexes to replay
  gapAt?: { afterSeq: number; lost: number }; // simulate missed events
  failWith?: 'transport_error' | 'none' | 'user_abort';
  transportTerminal?: 'loadingFinished' | 'loadingFailed' | 'none';
  contentType?: string;           // 'text/event-stream' => sse framing, otherwise raw chunks
  rscLike?: boolean;              // emit Flight-style multi-frame payload
  accountScope?: string;          // route by sessionId of a child target (worker etc.)
}

export interface ViewScript {
  targets?: Array<{ targetId: string; kind: 'iframe' | 'dedicated_worker' | 'shared_worker' | 'service_worker'; afterNav?: boolean; skipAttach?: boolean }>;
  streams?: StreamScript[];
  webSocket?: { url: string; frames: Array<{ payload: string; eventId?: string; duplicateOf?: number }>; closeFrame?: boolean; errorClose?: boolean };
  downloads?: Array<{ url: string; filename: string; bytes: number }>;
  crashDuringStream?: boolean;
  navigateDuringStream?: { to: string };
  devToolsOpenedExternally?: boolean;
  queueCapacityBytes?: number;
  sentinel?: string;              // storage sentinel the mock isolates per partition
}

export class MockBrowserAdapter implements BrowserAdapter {
  readonly kind = 'mock' as const;
  #views = new Map<string, MockAccountView>();
  #seed = 4242;

  setSeed(s: number): void { this.#seed = s >>> 0; }

  capabilities(): AdapterCapabilities {
    return {
      kind: 'mock',
      attachBeforeNavigate: true,
      flattenedTargetAttach: true,
      responseBodies: 'full',
      isolatedWorldScript: true,
      downloadHook: true,
      durableMessages: false,
      notes: ['models documented CDP semantics for adversarial testing; proves nothing about Arena specifically'],
    };
  }

  async createAccountView(opts: AccountViewOptions & { script?: ViewScript }): Promise<AccountView> {
    const v = new MockAccountView(opts, this.#seed++, this);
    this.#views.set(opts.accountId, v);
    return v;
  }

  /** Sentinels are partition-scoped in the mock the same way Electron isolates them. */
  #sentinels = new Map<string, Map<string, string>>(); // account -> key -> value

  writeSentinel(accountId: string, key: string, value: string): void {
    let m = this.#sentinels.get(accountId);
    if (!m) { m = new Map(); this.#sentinels.set(accountId, m); }
    m.set(key, value);
  }
  readSentinel(accountId: string, key: string): string | undefined {
    return this.#sentinels.get(accountId)?.get(key);
  }

  async dispose(): Promise<void> {
    for (const v of this.#views.values()) await v.close();
    this.#views.clear();
  }

  viewFor(accountId: string): MockAccountView | undefined { return this.#views.get(accountId); }
}

export class MockAccountView implements AccountView {
  readonly accountId: string;
  #events: AdapterEvent[] = [];
  #listeners = new Set<(e: AdapterEvent) => void>();
  #steps: ProtocolStep[] = [];
  #acked = new Set<string>();
  #navigated = false;
  #closed = false;
  #script: ViewScript;
  #rnd: () => number;
  #storagePath: string;
  #attached = false;
  #autoAttach?: { flatten: true; waitForDebuggerOnStart: true };
  #bindingWorld?: string;
  #witnessInstalled = false;
  #devToolsOpen = false;
  #fetchHandler?: (input: { url: string }) => Promise<FetchInSessionResult>;
  /** Records of what page code observed (for isolation proofs). */
  #witnessLog: unknown[] = [];

  #host: MockBrowserAdapter;
  constructor(opts: AccountViewOptions & { script?: ViewScript }, seed: number, host: MockBrowserAdapter) {
    this.#host = host;
    this.accountId = opts.accountId;
    this.#script = opts.script ?? {};
    this.#storagePath = opts.storagePath;
    this.#rnd = mulberry32(seed);
  }

  get recordedSteps(): ProtocolStep[] { return [...this.#steps]; }
  get recordedEvents(): AdapterEvent[] { return [...this.#events]; }
  get witnessLog(): unknown[] { return [...this.#witnessLog]; }
  get attached(): boolean { return this.#attached; }
  isAttached(): boolean { return this.#attached; }
  get autoAttachOpts(): { flatten: true; waitForDebuggerOnStart: true } | undefined { return this.#autoAttach; }
  get bindingWorld(): string | undefined { return this.#bindingWorld; }
  get witnessInstalled(): boolean { return this.#witnessInstalled; }
  get navigatedUrl(): boolean { return this.#navigated; }

  setFetchHandler(h: (input: { url: string }) => Promise<FetchInSessionResult>): void { this.#fetchHandler = h; }
  get storagePath(): string { return this.#storagePath; }

  capabilities(): AdapterCapabilities { return this.#host.capabilities(); }

  #emit(e: AdapterEvent): void {
    this.#events.push(e);
    for (const l of this.#listeners) l(e);
  }
  #step(s: ProtocolStepInput): void {
    const full = { ...s, at: this.#steps.length } as ProtocolStep;
    this.#steps.push(full);
    this.#emit({ type: 'protocol_step', detail: full as unknown as Record<string, unknown> });
  }

  async attach(): Promise<void> {
    if (this.#devToolsOpen) {
      // Chromium detaches the debugger when DevTools holds the target; refuse to half-attach.
      this.#emit({ type: 'diagnostic', detail: { code: 'attach_refused_devtools', account_id: this.accountId } });
      throw new Error('debugger attach refused: DevTools opened on the target');
    }
    this.#attached = true;
    this.#step({ step: 'create_account_view', account_id: this.accountId });
    this.#step({ step: 'bind_account', account_id: this.accountId });
    this.#step({ step: 'create_capture_queue', account_id: this.accountId });
    this.#step({ step: 'debugger_attach', account_id: this.accountId });
  }

  #devToolsOpenExternally(): boolean { return this.#devToolsOpen; }

  async enableNetwork(o: { bufferSizeBytes: number }): Promise<void> {
    this.#requireAttached('Network.enable');
    this.#acked.add('Network');
    void o.bufferSizeBytes;
    this.#step({ step: 'domain_enable', domain: 'Network', ack: true });
  }
  async enablePage(): Promise<void> {
    this.#requireAttached('Page.enable');
    this.#acked.add('Page');
    this.#step({ step: 'domain_enable', domain: 'Page', ack: true });
  }
  async enableRuntime(): Promise<void> {
    this.#requireAttached('Runtime.enable');
    this.#acked.add('Runtime');
    this.#step({ step: 'domain_enable', domain: 'Runtime', ack: true });
  }
  #requireAttached(op: string): void {
    if (!this.#attached) throw new Error(`${op} requires debugger attachment first`);
  }
  async addIsolatedBinding(name: string, world: string): Promise<void> {
    this.#requireAttached('Runtime.addBinding');
    if (world === '') throw new Error('binding must target an isolated world');
    this.#bindingWorld = world;
    this.#step({ step: 'add_binding', name, isolatedWorld: world === 'arena-archive' });
  }
  async addScriptOnNewDocument(source: string, world: string): Promise<void> {
    this.#requireAttached('Page.addScriptToEvaluateOnNewDocument');
    if (world !== 'arena-archive') throw new Error('only the arena-archive isolated world may receive scripts');
    this.#witnessInstalled = true;
    void source;
    this.#step({ step: 'add_script_to_evaluate_on_new_document', world });
  }
  async setAutoAttach(o: { flatten: true; waitForDebuggerOnStart: true }): Promise<void> {
    this.#requireAttached('Target.setAutoAttach');
    this.#autoAttach = o;
    this.#step({ step: 'set_auto_attach', autoAttach: true, flatten: o.flatten, waitForDebuggerOnStart: o.waitForDebuggerOnStart });
  }
  async verifyAcknowledgements(): Promise<{ allAcked: boolean; missing: string[] }> {
    const missing = ['Network', 'Page', 'Runtime'].filter((d) => !this.#acked.has(d));
    return { allAcked: missing.length === 0, missing };
  }

  /**
   * Navigation triggers the scripted traffic. Every emitted event is a CDP-shaped
   * message the supervisor consumes exactly like production.
   */
  async navigate(url: string): Promise<void> {
    this.#requireAttached('navigation');
    if (!/^https:\/\/arena\.ai(\/|$)/.test(url)) throw new Error('navigate blocked: non-Arena origin');
    this.#step({ step: 'navigate', url });
    this.#navigated = true;
    // document request + page target events
    this.#emit({ type: 'target_attached', targetId: 'page_main', sessionId: 'sess_main', targetKind: 'page' });
    this.#emit({ type: 'cdp', cdp: { method: 'Page.frameNavigated', params: { frame: { id: 'page_main', url } } } });

    // child targets: iframe + workers + service worker, freeze/arm/resume
    const targets = this.#script.targets ?? [];
    for (const t of targets) {
      if (t.afterNav) {
        this.#emit({ type: 'target_attached', targetId: t.targetId, sessionId: `sess_${t.targetId}`, parentTargetId: 'page_main', targetKind: t.kind });
      }
    }

    // streams
    const streams = this.#script.streams ?? [];
    for (const st of streams) this.#emitStream(st);

    // websockets
    const ws = this.#script.webSocket;
    if (ws) {
      this.#emit({ type: 'cdp', cdp: { method: 'Network.webSocketCreated', params: { requestId: 'ws1', url: ws.url, initiator: { type: 'script' } } } });
      this.#emit({ type: 'cdp', cdp: { method: 'Network.webSocketHandshakeResponseReceived', params: { requestId: 'ws1', response: { status: 101, statusText: 'Switching Protocols', headers: {} } } } });
      for (let i = 0; i < ws.frames.length; i++) {
        const f = ws.frames[i]!;
        this.#emit({ type: 'cdp', cdp: { method: 'Network.webSocketFrameReceived', params: { requestId: 'ws1', response: { opcode: 1, mask: false, payloadData: f.payload }, timestamp: 1000 + i } } });
        if (f.duplicateOf !== undefined) {
          const d = ws.frames[f.duplicateOf]!;
          this.#emit({ type: 'cdp', cdp: { method: 'Network.webSocketFrameReceived', params: { requestId: 'ws1', response: { opcode: 1, mask: false, payloadData: d.payload }, timestamp: 1000 + i + 0.5 } } });
        }
      }
      if (ws.closeFrame) this.#emit({ type: 'cdp', cdp: { method: 'Network.webSocketClosed', params: { requestId: 'ws1' } } });
      if (ws.errorClose) this.#emit({ type: 'cdp', cdp: { method: 'Network.webSocketFrameError', params: { requestId: 'ws1', errorMessage: 'net::ERR_CONNECTION_RESET' } } });
    }

    // downloads
    for (const d of this.#script.downloads ?? []) {
      this.#emit({ type: 'download', download: { url: d.url, suggestedFilename: d.filename, contentLength: d.bytes } });
    }

    // renderer loss during/after stream
    if (this.#script.crashDuringStream) {
      this.#emit({ type: 'renderer_gone', detail: { reason: 'crashed', account_id: this.accountId } });
    }
  }

  #emitStream(st: StreamScript): void {
    const bytes = typeof st.body === 'string' ? Buffer.from(st.body, 'utf8') : Buffer.from(st.body);
    const rid = st.requestId;
    const session = st.accountScope ? `sess_${st.accountScope}` : undefined;
    const emitCdp = (method: string, params: Record<string, unknown>): void => {
      this.#emit({ type: 'cdp', cdp: { method, params, sessionId: session }, sessionId: session });
    };
    emitCdp('Network.requestWillBeSent', {
      requestId: rid,
      request: { url: st.url, method: st.method, headers: { Authorization: 'Bearer leak-canary-xyz' } },
      timestamp: 1,
    });
    const headers: Record<string, string> = { 'content-type': st.contentType ?? 'application/json' };
    if (st.transportTerminal !== 'none') headers['content-length'] = String(bytes.length);
    emitCdp('Network.responseReceived', {
      requestId: rid,
      response: { status: 200, headers, mimeType: st.contentType ?? 'application/json' },
      timestamp: 2,
    });

    const chunkSize = st.chunkSize && st.chunkSize > 0 ? st.chunkSize : 0;
    let off = 0;
    let seq = 0;
    const pending: Array<{ seq: number; data: Uint8Array }> = [];
    while (off < bytes.length) {
      const len = chunkSize > 0 ? chunkSize : 1 + Math.floor(this.#rnd() * 13);
      const data = new Uint8Array(bytes.subarray(off, Math.min(bytes.length, off + len)));
      pending.push({ seq, data });
      off += len;
      seq++;
    }
    // simulate a *lost* middle segment if requested (observer missed these events)
    const lostAfter = st.gapAt ? st.gapAt.afterSeq : -1;
    if (st.contentType === 'text/event-stream') {
      // CDP delivers *parsed* records, not byte fragments: split the logical SSE
      // stream into records exactly as a real EventSource consumer would see them.
      const text = bytes.toString('utf8');
      const records = text.split('\n\n').filter((r) => r.trim() !== '');
      let rseq = 0;
      for (const rec of records) {
        if (st.gapAt && rseq > lostAfter && rseq <= lostAfter + st.gapAt.lost) { rseq++; continue; }
        const dataLines = rec.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
        emitCdp('Network.eventSourceMessageReceived', {
          requestId: rid, eventName: 'message', data: dataLines.join('\n'), timestamp: 3 + rseq,
        });
        if (st.duplicateChunks?.includes(rseq)) {
          emitCdp('Network.eventSourceMessageReceived', {
            requestId: rid, eventName: 'message', data: dataLines.join('\n'), timestamp: 3 + rseq + 0.5,
          });
        }
        rseq++;
      }
    } else for (const c of pending) {
      if (st.gapAt && c.seq > lostAfter && c.seq <= lostAfter + st.gapAt.lost) continue;
      {
        emitCdp('Network.dataReceived', {
          requestId: rid, dataLength: c.data.length, encodedDataLength: c.data.length,
          data: Buffer.from(c.data).toString('base64'), timestamp: 3 + c.seq,
        });
      }
      if (st.duplicateChunks?.includes(c.seq)) {
        emitCdp('Network.dataReceived', {
          requestId: rid, dataLength: c.data.length, encodedDataLength: c.data.length,
          data: Buffer.from(c.data).toString('base64'), timestamp: 3 + c.seq + 0.5,
        });
      }
    }
    if (st.transportTerminal === 'loadingFinished') {
      emitCdp('Network.loadingFinished', { requestId: rid, encodedDataLength: bytes.length, timestamp: 100 });
    } else if (st.transportTerminal === 'loadingFailed') {
      emitCdp('Network.loadingFailed', {
        requestId: rid,
        errorText: st.failWith === 'user_abort' ? 'net::ERR_ABORTED' : 'net::ERR_CONNECTION_RESET',
        canceled: st.failWith === 'user_abort',
        timestamp: 100,
      });
    }
    if (st.rscLike) {
      emitCdp('Network.responseReceived', {
        requestId: rid + '_rsc',
        response: { status: 200, headers: { 'content-type': 'text/x-component' }, mimeType: 'text/x-component' },
        timestamp: 101,
      });
      emitCdp('Network.loadingFinished', { requestId: rid + '_rsc', encodedDataLength: 0, timestamp: 102 });
    }
    if (this.#script.navigateDuringStream) {
      emitCdp('Page.frameNavigated', { frame: { id: 'page_main', url: this.#script.navigateDuringStream.to } });
    }
  }

  async fetchInSession(input: { url: string; method: 'GET' }): Promise<FetchInSessionResult> {
    if (!this.#navigated) throw new Error('fetchInSession requires an attached, navigated session (owner present)');
    if (!this.#fetchHandler) return { ok: false, status: 499, bodyText: '', headers: {} };
    return this.#fetchHandler(input);
  }

  async uiTraversalStep(): Promise<void> {
    // traversal is exercised through fetchInSession + synthetic witness messages in gates
  }

  async setDevToolsOpen(open: boolean): Promise<void> {
    this.#devToolsOpen = open;
    if (open && this.#attached) {
      this.#attached = false;
      this.#emit({ type: 'diagnostic', detail: { code: 'debugger_detached', reason: 'devtools_opened' } });
    }
  }

  /** Witness injection: the isolated world calls the binding; the page cannot. */
  simulateWitnessMessage(msg: unknown): void {
    this.#witnessLog.push(msg);
    this.#emit({ type: 'cdp', cdp: { method: 'Runtime.bindingCalled', params: { name: '__ARENA_ARCHIVE__', payload: JSON.stringify(msg) } } });
  }

  onEvent(cb: (e: AdapterEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => { this.#listeners.delete(cb); };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
  }
}

export function mulberry32(a: number): () => number {
  let s = a >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Completeness for a mock stream, as the supervisor would derive it (kept here for gate unit tests). */
export function mockStreamCompleteness(st: StreamScript, observedLost: boolean): CompletenessState {
  if (observedLost) return 'observer_gap';
  if (st.transportTerminal === 'none') return st.failWith === 'user_abort' ? 'stopped_by_user' : 'partial_stream';
  if (st.transportTerminal === 'loadingFailed') return st.failWith === 'user_abort' ? 'stopped_by_user' : 'failed_transport';
  return 'complete';
}

/** content hash helper reused by fixtures */
export function bodyHash(b: string): string {
  return createHash('sha256').update(Buffer.from(b, 'utf8')).digest('hex');
}
