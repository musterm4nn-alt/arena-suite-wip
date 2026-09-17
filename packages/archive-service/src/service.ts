import { ArchiveError, canonicalJson, newId, sha256Hex, type Clock, systemClock } from '@arena/core';
import { DirectiveBroker, type DirectiveScope } from '@arena/security';
import { ProtocolCatalog } from '@arena/protocol-catalog';
import { CaptureQueue, EventRouter } from '@arena/capture-core';
import { CapturePipeline } from './pipeline.ts';
import type { AdapterEvent, BrowserAdapter, AccountView } from '@arena/browser-adapter';
import { z } from 'zod';
import { ArchiveStore } from './store.ts';
import { exportBundleJson, importBundleJson, type BundleShape } from './export-import.ts';

/**
 * Service registry: the single source of truth both the GUI and MCP call, so
 * semantics cannot drift between operator surfaces (§12). Destructive commands
 * require directives this registry can never mint (§11.3).
 */

export interface CapabilityReport {
  adapterKind: 'electron' | 'mock';
  dbBackend: 'sqlcipher' | 'node-sqlite';
  dbEncrypted: boolean;
  keychainBackedKey: boolean;
  ownerSessionVerified: boolean;
  notes: string[];
}

export interface SyncBridge {
  start(accountId: string): Promise<{ job_id: string }>;
  status(jobId: string): Promise<unknown>;
  pause(jobId: string): Promise<unknown>;
  resume(jobId: string): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  coverage(accountId: string): Promise<unknown>;
  verifyRead(accountId: string, opId: string): Promise<unknown>;
}

export interface AnalysisBridge {
  run(accountId: string): Promise<unknown>;
  compare(runIds: string[]): Promise<unknown>;
  excerpts(runId: string, n: number): Promise<unknown>;
}

export interface MaintenanceBridge {
  backup(destination: string): Promise<unknown>;
  restore(bundleDir: string, directiveId: string): Promise<unknown>;
}

export interface ServiceOptions {
  store: ArchiveStore;
  catalog: ProtocolCatalog;
  capabilities: CapabilityReport;
  directives?: DirectiveBroker;
  clock?: Clock;
  adapter?: BrowserAdapter;
  sync?: SyncBridge;
  analysis?: AnalysisBridge;
  maintenance?: MaintenanceBridge;
  maxStreamBytes?: number;
  queueCapacity?: number;
}

export interface CommandDef {
  name: string;
  domain: 'accounts' | 'capture' | 'sync' | 'archive' | 'diagnostics' | 'analysis' | 'maintenance';
  destructive?: boolean;
  blockedWhenLocked?: boolean; // default true
  input: z.ZodTypeAny;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any, ctx: ServiceCtx) => unknown | Promise<unknown>;
}

export interface ServiceCtx {
  service: ArchiveService;
}

interface CaptureHandle {
  view: AccountView;
  epochId: string;
  pipeline: CapturePipeline;
  paused: boolean;
  detachOff: () => void;
}

export class ArchiveService {
  readonly store: ArchiveStore;
  readonly catalog: ProtocolCatalog;
  readonly directives: DirectiveBroker;
  readonly capabilities: CapabilityReport;
  readonly clock: Clock;
  #locked = false;
  #unlockToken: string | null = null;
  #adapter: BrowserAdapter | null;
  #views = new Map<string, CaptureHandle>();
  #commands: CommandDef[];
  #sync: SyncBridge | null;
  #analysis: AnalysisBridge | null;
  #maintenance: MaintenanceBridge | null;
  #maxStreamBytes: number;
  #queueCapacity: number;

  constructor(opts: ServiceOptions) {
    this.store = opts.store;
    this.catalog = opts.catalog;
    this.directives = opts.directives ?? new DirectiveBroker({ clock: opts.clock });
    this.capabilities = opts.capabilities;
    this.clock = opts.clock ?? systemClock;
    this.#adapter = opts.adapter ?? null;
    this.#sync = opts.sync ?? null;
    this.#analysis = opts.analysis ?? null;
    this.#maintenance = opts.maintenance ?? null;
    this.#maxStreamBytes = opts.maxStreamBytes ?? 32 << 20;
    this.#queueCapacity = opts.queueCapacity ?? 2048;
    this.#commands = buildCommands();
  }

  get locked(): boolean { return this.#locked; }
  get unlockToken(): string | null { return this.#unlockToken; }
  get adapter(): BrowserAdapter | null { return this.#adapter; }
  get views(): ReadonlyMap<string, CaptureHandle> { return this.#views; }
  setAdapter(a: BrowserAdapter): void { this.#adapter = a; }
  setSyncBridge(b: SyncBridge | null): void { this.#sync = b; }
  setAnalysisBridge(b: AnalysisBridge | null): void { this.#analysis = b; }
  setMaintenanceBridge(b: MaintenanceBridge | null): void { this.#maintenance = b; }

  commands(): readonly CommandDef[] { return this.#commands; }
  commandNames(): string[] { return this.#commands.map((c) => c.name); }

  pipelineFor(accountId: string): CapturePipeline | undefined { return this.#views.get(accountId)?.pipeline; }
  sync(): SyncBridge { if (!this.#sync) throw new ArchiveError('E_UNSUPPORTED', 'sync engine not wired'); return this.#sync; }
  analysis(): AnalysisBridge { if (!this.#analysis) throw new ArchiveError('E_UNSUPPORTED', 'analysis engine not wired'); return this.#analysis; }
  maintenance(): MaintenanceBridge { if (!this.#maintenance) throw new ArchiveError('E_UNSUPPORTED', 'maintenance not wired'); return this.#maintenance; }

  /** MCP/GUI entry point: validate, enforce lock/scope rules, structured errors only. */
  async dispatch(name: string, args: unknown): Promise<unknown> {
    const cmd = this.#commands.find((c) => c.name === name);
    if (!cmd) throw new ArchiveError('E_UNSUPPORTED', `unknown command ${name}`);
    if (this.#locked && cmd.blockedWhenLocked !== false && cmd.name !== 'maintenance_unlock') {
      throw new ArchiveError('E_LOCKED', 'archive locked for maintenance');
    }
    const parsed = cmd.input.safeParse(args ?? {});
    if (!parsed.success) {
      throw new ArchiveError('E_INVALID_ARGS', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    return await cmd.run(parsed.data, { service: this });
  }

  // ---- capture supervision (app's privileged side) ----
  async openCapture(accountId: string): Promise<{ epoch_id: string }> {
    if (!this.#adapter) throw new ArchiveError('E_UNSUPPORTED', 'no browser adapter attached');
    const storagePath = `Application Support/ArenaArchive/partitions/${accountId}/`;
    const view = await this.#adapter.createAccountView({ accountId, storagePath, allowPopupsSamePartition: true });
    const epochId = this.store.beginEpoch(accountId);
    const pipeline = new CapturePipeline({
      store: this.store, catalog: this.catalog,
      queue: new CaptureQueue(this.#queueCapacity), router: new EventRouter(), maxStreamBytes: this.#maxStreamBytes,
    });
    const detachOff = pipeline.attachAdapter(view as { onEvent(cb: (e: AdapterEvent) => void): () => void; accountId: string }, epochId);
    this.#views.set(accountId, { view, epochId, pipeline, paused: false, detachOff });
    return { epoch_id: epochId };
  }

  closeCapture(accountId: string): void {
    const v = this.#views.get(accountId);
    if (!v) throw new ArchiveError('E_NOT_FOUND', 'no capture for account');
    v.detachOff();
    this.store.endEpoch(v.epochId);
    void v.view.close();
    this.#views.delete(accountId);
  }

  // ---- deletion (directive-verified, tombstoned) ----
  deleteConversation(conversationId: string, directiveId: string): { removed_turns: number; removed_parts: number } {
    const row = this.store.db.prepare('SELECT account_id FROM conversation WHERE id=?').get(conversationId) as { account_id: string } | undefined;
    if (!row) throw new ArchiveError('E_NOT_FOUND', 'conversation');
    const scope: DirectiveScope = { scope: 'conversation', ids: [conversationId] };
    this.directives.consume(directiveId, scope);
    const stats = this.store.deleteConversationScoped(conversationId);
    this.store.writeTombstone({
      accountId: row.account_id, scope: 'conversation', targetId: conversationId,
      scopeHash: shaOf(scope), directiveId,
    });
    return { removed_turns: stats.turns, removed_parts: stats.parts };
  }

  deleteAccount(accountId: string, directiveId: string): { tombstoned: true } {
    const scope: DirectiveScope = { scope: 'account', ids: [accountId] };
    this.directives.consume(directiveId, scope);
    // pause capture for the account first (§11.3 rule 6)
    if (this.#views.has(accountId)) this.closeCapture(accountId);
    const convs = this.store.db.prepare('SELECT id FROM conversation WHERE account_id=?').all(accountId) as { id: string }[];
    for (const c of convs) this.store.deleteConversationScoped(c.id);
    this.store.setAccountEnabled(accountId, false);
    this.store.writeTombstone({ accountId, scope: 'account', targetId: accountId, scopeHash: shaOf(scope), directiveId });
    return { tombstoned: true };
  }

  /** Trusted GUI/CLI surface only; deliberately NOT a dispatchable command (§11.3 rule 1). */
  mintDeleteDirective(scope: DirectiveScope): { id: string; exactScopeDescription: string; expiresAt: number } {
    return this.directives.mint(scope);
  }

  // ---- lock ----
  lock(token?: string): { locked: true; unlock_token_provided: boolean } {
    this.#locked = true;
    this.#unlockToken = token ?? newId('unlock');
    return { locked: true, unlock_token_provided: token !== undefined };
  }
  unlock(token: string): { unlocked: boolean } {
    if (!this.#unlockToken || token !== this.#unlockToken) throw new ArchiveError('E_CONFIRM_REQUIRED', 'bad unlock token');
    this.#locked = false;
    this.#unlockToken = null;
    return { unlocked: true };
  }

  async recover(rebuildFts: boolean): Promise<{ integrity: string; ftsRows?: number; staging: { removedStaging: string[] } | null }> {
    const { integrityCheck } = await import('@arena/schema');
    const integ = integrityCheck(this.store.db);
    let ftsRows: number | undefined;
    if (rebuildFts) ftsRows = this.store.ftsRebuild();
    return { integrity: integ.ok ? 'ok' : `FAILED: ${integ.detail}`, ...(ftsRows !== undefined ? { ftsRows } : {}), staging: null };
  }

  exportBundle(accountId: string, conversationIds?: string[]): BundleShape {
    return exportBundleJson(this.store, accountId, conversationIds);
  }

  importBundle(accountId: string, bundle: unknown): { imported_conversations: number; imported_turns: number } {
    return importBundleJson(this.store, accountId, bundle as BundleShape);
  }

  // ---- protocol catalog snapshot persistence ----
  persistCatalog(): void { this.store.persistCatalog(this.catalog.snapshotJson()); }
  restoreCatalog(): boolean {
    const row = this.store.loadCatalog();
    if (!row) return false;
    try {
      const ops = JSON.parse(String((row as { value: string }).value));
      this.catalog.restore(ops);
      return true;
    } catch { return false; }
  }
}

function shaOf(scope: DirectiveScope): string {
  return sha256Hex(canonicalJson({ scope: scope.scope, ids: [...scope.ids].sort() }));
}

// Read-only diagnostics must remain answerable while maintenance locks are held (§12.2).
const DIAG_FREE = { blockedWhenLocked: false } as const;

const accountScopeArg = z.object({ account_id: z.string().min(1) }).or(z.object({ all: z.literal(true) }));

function buildCommands(): CommandDef[] {
  const cmd = <T extends z.ZodTypeAny>(
    name: string,
    domain: CommandDef['domain'],
    input: T,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: (a: any, ctx: ServiceCtx) => unknown | Promise<unknown>,
    extra?: Partial<CommandDef>
  ): CommandDef => ({ name, domain, input, run, ...extra });

  return [
    // accounts
    cmd('accounts_list', 'accounts', z.object({}), (_a, ctx) => ctx.service.store.listAccounts()),
    cmd('accounts_get', 'accounts', z.object({ account_id: z.string() }), (a, ctx) => {
      const row = ctx.service.store.db.prepare('SELECT * FROM account WHERE account_id=?').get(a.account_id);
      if (!row) throw new ArchiveError('E_NOT_FOUND', 'account');
      return row;
    }),
    cmd('accounts_create', 'accounts', z.object({ label: z.string().max(120).default(''), storage_path: z.string().min(1) }), (a, ctx) => ({ account_id: ctx.service.store.createAccount(a.label, a.storage_path) })),
    cmd('accounts_begin_signin', 'accounts', z.object({ account_id: z.string() }), (a, ctx) => {
      // Owner-driven sign-in only (§5): the app never reads mail or solves challenges.
      if (!ctx.service.views.has(a.account_id)) throw new ArchiveError('E_OWNER_ACTION_REQUIRED', 'open an account view first');
      return { status: 'NEEDS_OWNER_INTERACTION', instruction: 'sign in inside the Arena view; passive capture continues' };
    }),
    cmd('accounts_identity_probe', 'accounts', z.object({ account_id: z.string() }), (a, ctx) => {
      const epoch = ctx.service.store.activeEpoch(a.account_id);
      if (!epoch) throw new ArchiveError('E_AUTH_EXPIRED', 'no active session epoch');
      return { epoch_id: epoch.id, status: 'NEEDS_OWNER_INTERACTION' };
    }),
    cmd('accounts_set_enabled', 'accounts', z.object({ account_id: z.string(), enabled: z.boolean() }), (a, ctx) => {
      ctx.service.store.setAccountEnabled(a.account_id, a.enabled);
      return { ok: true };
    }),

    // capture
    cmd('capture_status', 'capture', z.object({}), (_a, ctx) => {
      const out: Record<string, unknown> = {};
      for (const [acct, v] of ctx.service.views) out[acct] = { paused: v.paused, epoch_id: v.epochId, ...v.pipeline.snapshot() };
      return out;
    }),
    cmd('capture_pause', 'capture', accountScopeArg, (a, ctx) => { forEachAccount(ctx, a, (id) => { const v = ctx.service.views.get(id); if (v) { v.paused = true; v.pipeline.paused = true; } }); return { paused: true }; }),
    cmd('capture_resume', 'capture', accountScopeArg, (a, ctx) => { forEachAccount(ctx, a, (id) => { const v = ctx.service.views.get(id); if (v) { v.paused = false; v.pipeline.paused = false; } }); return { resumed: true }; }),
    cmd('capture_stop_all', 'capture', z.object({}), (_a, ctx) => { for (const id of [...ctx.service.views.keys()]) ctx.service.closeCapture(id); return { stopped: true }; }),
    cmd('capture_completeness', 'capture', z.object({ account_id: z.string() }), (a, ctx) => ({
      counts: ctx.service.store.countsByCompleteness(a.account_id),
      live: ctx.service.pipelineFor(a.account_id)?.snapshot() ?? null,
    })),
    cmd('capture_repair', 'capture', z.object({ account_id: z.string() }), (a, ctx) => ({ drained: ctx.service.pipelineFor(a.account_id)?.drainQueue() ?? 0 })),

    // sync (bridge-backed)
    cmd('sync_start', 'sync', z.object({ account_id: z.string() }), (a, ctx) => ctx.service.sync().start(a.account_id)),
    cmd('sync_status', 'sync', z.object({ job_id: z.string() }), (a, ctx) => ctx.service.sync().status(a.job_id)),
    cmd('sync_pause', 'sync', z.object({ job_id: z.string() }), (a, ctx) => ctx.service.sync().pause(a.job_id)),
    cmd('sync_resume', 'sync', z.object({ job_id: z.string() }), (a, ctx) => ctx.service.sync().resume(a.job_id)),
    cmd('sync_cancel', 'sync', z.object({ job_id: z.string() }), (a, ctx) => ctx.service.sync().cancel(a.job_id)),
    cmd('sync_coverage', 'sync', z.object({ account_id: z.string() }), (a, ctx) => ctx.service.sync().coverage(a.account_id)),
    cmd('sync_verify_read', 'sync', z.object({ account_id: z.string(), op_id: z.string() }), (a, ctx) => ctx.service.sync().verifyRead(a.account_id, a.op_id)),

    // archive
    cmd('archive_search', 'archive', z.object({ account_id: z.string(), query: z.string().max(512), cursor: z.string().nullish(), limit: z.number().int().min(1).max(200).optional() }), (a, ctx) =>
      ctx.service.store.search({ accountId: a.account_id, query: a.query, cursor: a.cursor ?? null, limit: a.limit })),
    cmd('archive_get_conversation', 'archive', z.object({ conversation_id: z.string() }), (a, ctx) => {
      const c = ctx.service.store.getConversation(a.conversation_id);
      if (!c) throw new ArchiveError('E_NOT_FOUND', 'conversation');
      return { ...c, branches: c.branches.map((b) => ({ ...b, turns: ctx.service.store.getBranchTurns(String(b.id)) })) };
    }),
    cmd('archive_get_turn', 'archive', z.object({ turn_id: z.string() }), (a, ctx) => {
      const t = ctx.service.store.getTurn(a.turn_id);
      if (!t) throw new ArchiveError('E_NOT_FOUND', 'turn');
      return t;
    }),
    cmd('archive_get_provenance', 'archive', z.object({ entity_table: z.enum(['part', 'turn', 'conversation']), entity_id: z.string() }), (a, ctx) => {
      const links = ctx.service.store.provenanceFor(a.entity_table, a.entity_id);
      return links.map((l) => ({ ...l, observation: ctx.service.store.getObservation(Number(l.observation_id)) ?? null }));
    }),
    cmd('archive_list_branches', 'archive', z.object({ conversation_id: z.string() }), (a, ctx) => ctx.service.store.listBranches(a.conversation_id)),
    cmd('archive_export', 'archive', z.object({ account_id: z.string(), conversation_ids: z.array(z.string()).max(1000).optional() }), (a, ctx) =>
      ctx.service.exportBundle(a.account_id, a.conversation_ids), { blockedWhenLocked: false }),
    cmd('archive_import', 'archive', z.object({ account_id: z.string(), bundle: z.unknown() }), (a, ctx) => ctx.service.importBundle(a.account_id, a.bundle)),
    cmd('archive_get_artifact', 'archive', z.object({ artifact_id: z.string() }), () => {
      throw new ArchiveError('E_UNSUPPORTED', 'artifact retrieval requires the sealed blob store and an unlocked archive key');
    }),

    // diagnostics
    cmd('diagnostics_capabilities', 'diagnostics', z.object({}), (_a, ctx) => ctx.service.capabilities, DIAG_FREE),
    cmd('diagnostics_protocol_catalog', 'diagnostics', z.object({}), (_a, ctx) => ({ operations: ctx.service.catalog.operations, drift: ctx.service.catalog.driftEvents }), DIAG_FREE),
    cmd('diagnostics_drift', 'diagnostics', z.object({}), (_a, ctx) => ctx.service.catalog.driftEvents, DIAG_FREE),
    cmd('diagnostics_evidence', 'diagnostics', z.object({ account_id: z.string(), request_id: z.string() }), (a, ctx) => ctx.service.store.observationsForRequest(a.account_id, a.request_id), DIAG_FREE),
    cmd('diagnostics_storage_health', 'diagnostics', z.object({}), (_a, ctx) => ({ health: ctx.service.store.health(), conflicts: ctx.service.store.listConflicts() }), DIAG_FREE),
    cmd('diagnostics_recover', 'diagnostics', z.object({ rebuild_fts: z.boolean().default(false) }), (a, ctx) => ctx.service.recover(a.rebuild_fts), DIAG_FREE),

    // analysis
    cmd('analysis_profiles_run', 'analysis', z.object({ account_id: z.string() }), (a, ctx) => ctx.service.analysis().run(a.account_id)),
    cmd('analysis_compare', 'analysis', z.object({ run_ids: z.array(z.string()).min(2).max(8) }), (a, ctx) => ctx.service.analysis().compare(a.run_ids)),
    cmd('analysis_excerpts', 'analysis', z.object({ run_id: z.string(), n: z.number().int().min(1).max(20).default(5) }), (a, ctx) => ctx.service.analysis().excerpts(a.run_id, a.n)),
    cmd('analysis_profiles_get', 'analysis', z.object({ run_id: z.string() }), (a, ctx) => {
      const row = ctx.service.store.db.prepare('SELECT * FROM analysis_run WHERE id=?').get(a.run_id);
      if (!row) throw new ArchiveError('E_NOT_FOUND', 'run');
      return row;
    }),
    cmd('analysis_experiments', 'analysis', z.object({ kind: z.string() }), (a) => {
      throw new ArchiveError('E_UNSUPPORTED', `experiment '${a.kind}' requires the separate scientific gate (§13.2) and is disabled`);
    }),

    // maintenance
    cmd('maintenance_lock', 'maintenance', z.object({ token: z.string().min(8).optional() }), (a, ctx) => ctx.service.lock(a.token), { blockedWhenLocked: false }),
    cmd('maintenance_unlock', 'maintenance', z.object({ token: z.string() }), (a, ctx) => ctx.service.unlock(a.token), { blockedWhenLocked: false }),
    cmd('maintenance_backup', 'maintenance', z.object({ destination: z.string() }), (a, ctx) => ctx.service.maintenance().backup(a.destination), { blockedWhenLocked: false }),
    cmd('maintenance_restore', 'maintenance', z.object({ bundle_dir: z.string(), directive_id: z.string() }), (a, ctx) => ctx.service.maintenance().restore(a.bundle_dir, a.directive_id), { blockedWhenLocked: false, destructive: true }),
    cmd('maintenance_delete_conversation', 'maintenance', z.object({ conversation_id: z.string(), directive_id: z.string() }), (a, ctx) => ctx.service.deleteConversation(a.conversation_id, a.directive_id), { destructive: true }),
    cmd('maintenance_delete_account', 'maintenance', z.object({ account_id: z.string(), directive_id: z.string() }), (a, ctx) => ctx.service.deleteAccount(a.account_id, a.directive_id), { destructive: true }),
  ];
}

function forEachAccount(ctx: ServiceCtx, scope: { account_id?: string; all?: true }, fn: (id: string) => void): void {
  if ('all' in scope && scope.all) for (const id of ctx.service.views.keys()) fn(id);
  else if ('account_id' in scope && scope.account_id) fn(scope.account_id);
}
