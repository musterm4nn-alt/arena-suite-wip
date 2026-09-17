import { ArchiveError } from '@arena/core';
import type { BrowserAdapter, AccountView, AdapterEvent } from '@arena/browser-adapter';
import type { ProtocolStep, ProtocolStepInput } from '@arena/capture-core';
import { devtoolsOpenWouldDetach, verifyAttachBeforeNavigate } from '@arena/capture-core';
import { WITNESS_SOURCE } from './witness.ts';
import type { ArchiveService } from '@arena/archive-service';
import type { ArtifactStore } from '@arena/artifacts';
import { toSafeUrlRef } from '@arena/security';
import { sha256Hex } from '@arena/core';

/**
 * CaptureSupervisor (plan §4/§6): owns attach timing, partition identity,
 * target lifecycle and account stamping for one Arena view. It is the ONLY
 * component allowed to say which account an event belongs to.
 */

export interface SupervisorHandle {
  accountId: string;
  epochId: string;
  view: AccountView;
  steps: ProtocolStep[];
  detachOff: () => void;
}

export interface SupervisorOptions {
  adapter: BrowserAdapter;
  service: ArchiveService;
  artifacts?: ArtifactStore;
  archiveKey?: Uint8Array | null;
  queueCapacityBytes?: number;
  /** Called for every protocol step (diagnostics window subscribes). */
  onStep?: (step: ProtocolStep) => void;
  onHazard?: (code: string, detail: Record<string, unknown>) => void;
}

export class CaptureSupervisor {
  #opts: SupervisorOptions;
  #handles = new Map<string, SupervisorHandle>();
  #stepLog = new Map<string, ProtocolStep[]>();

  constructor(opts: SupervisorOptions) { this.#opts = opts; }

  async openAccountView(accountId: string): Promise<SupervisorHandle> {
    const storagePath = `Application Support/ArenaArchive/partitions/${accountId}/`;
    const view = await this.#opts.adapter.createAccountView({ accountId, storagePath, allowPopupsSamePartition: true });
    const steps = this.#stepLog.get(accountId) ?? [];
    this.#stepLog.set(accountId, steps);
    const track = (s: ProtocolStepInput): void => { steps.push({ ...s, at: steps.length } as ProtocolStep); };

    // §6.1 order — create with NO Arena URL, bind, queue, attach, enable,
    // isolated binding, witness script, auto-attach, verify acks, ONLY then navigate.
    track({ step: 'create_account_view', account_id: accountId });
    track({ step: 'bind_account', account_id: accountId });
    track({ step: 'create_capture_queue', account_id: accountId });
    await view.attach();
    track({ step: 'debugger_attach', account_id: accountId });
    const buf = this.#opts.queueCapacityBytes ?? 16 << 20;
    await view.enableNetwork({ bufferSizeBytes: buf, durable: this.#opts.adapter.capabilities().durableMessages });
    track({ step: 'domain_enable', domain: 'Network', ack: true });
    await view.enablePage();
    track({ step: 'domain_enable', domain: 'Page', ack: true });
    await view.enableRuntime();
    track({ step: 'domain_enable', domain: 'Runtime', ack: true });
    await view.addIsolatedBinding('__ARENA_ARCHIVE__', 'arena-archive');
    track({ step: 'add_binding', name: '__ARENA_ARCHIVE__', isolatedWorld: true });
    await view.addScriptOnNewDocument(WITNESS_SOURCE, 'arena-archive');
    track({ step: 'add_script_to_evaluate_on_new_document', world: 'arena-archive' });
    await view.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
    track({ step: 'set_auto_attach', autoAttach: true, flatten: true, waitForDebuggerOnStart: true });
    const acks = await view.verifyAcknowledgements();
    if (!acks.allAcked) throw new ArchiveError('E_INTERNAL', `acknowledgements missing: ${acks.missing.join(',')}`);
    const check = verifyAttachBeforeNavigate(steps.map((s, i) => ({ ...s, at: i })));
    if (!check.ok) throw new ArchiveError('E_INTERNAL', `attach protocol violated: ${check.failures.join('; ')}`);

    const epochId = this.#opts.service.store.beginEpoch(accountId);
    const detachOff = view.onEvent((e: AdapterEvent) => {
      if (e.type === 'diagnostic' && e.detail?.code === 'debugger_detached') {
        this.#opts.onHazard?.('debugger_detached', { account_id: accountId });
      }
      if (e.type === 'download' && e.download) void this.#onDownload(accountId, e.download);
    });
    // Pipeline attachment is service-side (openCapture); supervisor only owns protocol + hazards.
    const handle = { accountId, epochId, view, steps, detachOff };
    this.#handles.set(accountId, handle);
    return handle;
  }

  /** The ONLY navigation path; the first one must be the Arena origin (§6.1). */
  async navigateToArena(accountId: string): Promise<void> {
    const h = this.#handles.get(accountId);
    if (!h) throw new ArchiveError('E_NOT_FOUND', 'open the view first');
    await h.view.navigate('https://arena.ai/');
    h.steps.push({ step: 'navigate', url: 'https://arena.ai/', at: h.steps.length } as ProtocolStep);
    const check = verifyAttachBeforeNavigate(h.steps);
    if (!check.ok) this.#opts.onHazard?.('protocol_violation', { failures: check.failures });
  }

  /** DevTools on an attached Arena view can detach Electron's debugger — refuse. */
  async openDiagnosticsWindow(accountId: string): Promise<{ refused?: string; ok?: boolean }> {
    const h = this.#handles.get(accountId);
    if (!h) return { ok: true };
    if (devtoolsOpenWouldDetach(true, h.view.isAttached())) {
      return { refused: 'DevTools on Arena views are disabled; use the diagnostics window instead.' };
    }
    return { ok: true };
  }

  async #onDownload(accountId: string, d: { url: string; suggestedFilename: string; contentLength?: number }): Promise<void> {
    if (!this.#opts.artifacts || !this.#opts.archiveKey) return;
    const ref = toSafeUrlRef(d.url);
    try {
      // Downloads come from the app's own will-download pipeline; we stage under
      // the account dir and seal. In the mock environment bytes are unavailable.
      const res = await this.#opts.artifacts.seal(
        { archiveKey: this.#opts.archiveKey, accountId, sourceUrlSha256: sha256Hex(JSON.stringify(ref)), filename: d.suggestedFilename },
        new Uint8Array(0)
      );
      this.#opts.service.store.db.prepare('INSERT INTO artifact (id, account_id, filename_safe, source_url_ref, size_bytes, sha256, mime, blob_path, sealed_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(res.meta.blobId, accountId, d.suggestedFilename.slice(0, 128), JSON.stringify(ref), 0, res.meta.sha256, res.meta.mime, res.finalPath, Date.now());
    } catch (e) {
      this.#opts.service.store.recordConflict(accountId, 'artifact_seal_failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'error' });
    }
  }

  close(accountId: string): void {
    const h = this.#handles.get(accountId);
    if (!h) return;
    h.detachOff();
    this.#opts.service.store.endEpoch(h.epochId);
    void h.view.close();
    this.#handles.delete(accountId);
  }

  handle(accountId: string): SupervisorHandle | undefined { return this.#handles.get(accountId); }
}
