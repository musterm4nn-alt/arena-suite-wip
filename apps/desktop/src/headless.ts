import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, newId, sha256Hex } from '@arena/core';
import { openNodeSqlite, migrate } from '@arena/schema';
import { DirectiveBroker } from '@arena/security';
import { ProtocolCatalog } from '@arena/protocol-catalog';
import { MockBrowserAdapter } from '@arena/browser-adapter';
import { ArchiveService, ArchiveStore } from '@arena/archive-service';
import { ArtifactStore, FileKeyWrapper } from '@arena/artifacts';
import { AccountSyncJob, type SyncExecutor, type SyncStore, type Checkpoint, type PageItem } from '@arena/sync';
import type { SyncBridge } from '@arena/archive-service';
import { buildCorpus, runProfiles, compareReports, type ProfileReport } from '@arena/analysis';
import { makeCorpus } from '@arena/fixtures';
import { CaptureSupervisor } from './supervisor.ts';

/**
 * Headless stack: the exact same service wiring the Electron app uses, with
 * the mock browser adapter. Used by P1/P2/P5 gates and by tests. It proves the
 * *architecture and dataflow*, not Chromium behavior (see evidence register).
 */
export interface HeadlessStack {
  db: ReturnType<typeof openNodeSqlite>;
  store: ArchiveStore;
  catalog: ProtocolCatalog;
  adapter: MockBrowserAdapter;
  service: ArchiveService;
  supervisor: CaptureSupervisor;
  artifacts: ArtifactStore;
  archiveKey: Uint8Array;
  directives: DirectiveBroker;
  root: string;
  dispose(): Promise<void>;
  /** convenience for gates: run a scripted scenario end-to-end */
  runScriptedTurn(accountId: string, script: import('@arena/browser-adapter').ViewScript): Promise<{ turnFound: boolean; detail?: unknown }>;
  /** register the owner-session executor used by sync jobs for an account */
  registerSyncExecutor(accountId: string, ex: SyncExecutor): void;
  /** drive the account's queued job through a full qualified walk (owner-session driver stand-in) */
  runSyncWalk(accountId: string, opId: string): Promise<{ pages: number; job: { state: string } }>;
}

export async function createHeadlessStack(opts: { root?: string } = {}): Promise<HeadlessStack> {
  const root = opts.root ?? await mkdtemp(join(tmpdir(), 'arena-archive-'));
  const db = openNodeSqlite(join(root, 'archive.db'));
  migrate(db);
  const store = new ArchiveStore(db);
  const catalog = new ProtocolCatalog();
  const adapter = new MockBrowserAdapter();
  const directives = new DirectiveBroker();
  const keyWrapper = new FileKeyWrapper(join(root, 'keys'));
  await keyWrapper.ensureArchiveKey('archive');
  const archiveKey = (await keyWrapper.unwrapArchiveKey('archive'))!;
  const artifacts = new ArtifactStore(join(root, 'artifacts'));
  await artifacts.init();

  const service = new ArchiveService({
    store, catalog, adapter, directives,
    capabilities: {
      adapterKind: 'mock', dbBackend: 'node-sqlite', dbEncrypted: false,
      keychainBackedKey: false, ownerSessionVerified: false,
      notes: [
        'sandbox stack: mock adapter + plaintext sqlite; SQLCipher/Keychain surfaces are macOS-only and unverified here',
        'artifact blobs ARE AES-256-GCM sealed with a sandbox-wrapped key (protocol proof, not security grading)',
      ],
    },
  });

  // ---- analysis bridge: profiles over complete turns with observed identity ----
  const analysisRuns = new Map<string, { report: unknown; corpusHash: string }>();
  service.setAnalysisBridge({
    async run(accountId: string) {
      const rows = store.db.prepare(`
        SELECT t.id AS turn_id, t.completeness, t.started_at, t.ended_at, c.id AS conversation_id, p.resolved_name AS cohort, p.resolution AS resolution
        FROM turn t JOIN branch b ON b.id=t.branch_id JOIN conversation c ON c.id=b.conversation_id
        LEFT JOIN participant p ON p.conversation_id=c.id AND p.position=0
        WHERE c.account_id=? AND c.suppressed=0 AND t.role='assistant'
        ORDER BY t.rowid`).all(accountId) as Array<{ turn_id: string; completeness: string; started_at: number | null; ended_at: number | null; conversation_id: string; cohort: string | null; resolution: string | null }>;
      const corpusRows = rows.map((r) => {
        const parts = store.db.prepare('SELECT kind, content_json FROM part WHERE turn_id=? ORDER BY idx').all(r.turn_id) as { kind: string; content_json: string }[];
        const texts = parts.map((p) => {
          try { return { kind: p.kind, text: String((JSON.parse(p.content_json) as { text?: string }).text ?? '') }; } catch { return { kind: p.kind, text: '' }; }
        });
        const obsCohort = (r.resolution === 'revealed' || r.resolution === 'selected' || r.resolution === 'request_catalog') && r.cohort ? r.cohort : 'unresolved';
        type Inc = 'complete' | 'partial_stream' | 'observer_gap' | 'stopped_by_user';
        const comp = (['complete', 'partial_stream', 'observer_gap', 'stopped_by_user'].includes(r.completeness) ? r.completeness : 'observer_gap') as Inc;
        return {
          turn_id: r.turn_id, account_id: accountId, conversation_id: r.conversation_id,
          completeness: comp, cohort: obsCohort, role: 'assistant' as const,
          text: texts.map((t) => t.text).join(' '), parts: texts,
          started_at: r.started_at ?? 0, ended_at: r.ended_at ?? 0,
        };
      });
      const snapshot = buildCorpus(corpusRows);
      const report = runProfiles(snapshot);
      const runId = newId('run');
      store.db.prepare('INSERT INTO analysis_run (id, kind, corpus_hash, code_version, config_json, created_at, report_json) VALUES (?,?,?,?,?,?,?)')
        .run(runId, 'profiles', snapshot.corpus_hash, report.code_version, canonicalJson({ include: 'complete+observed' }), Date.now(), canonicalJson(report));
      analysisRuns.set(runId, { report, corpusHash: snapshot.corpus_hash });
      return { run_id: runId, corpus_hash: snapshot.corpus_hash, n_turns: report.metrics.chars_total?.n ?? 0, excluded: snapshot.excluded };
    },
    async compare(runIds: string[]) {
      const reports: ProfileReport[] = [];
      for (const id of runIds) {
        const row = store.db.prepare('SELECT report_json FROM analysis_run WHERE id=?').get(id) as { report_json: string } | undefined;
        if (!row) throw new Error(`unknown run ${id}`);
        reports.push(JSON.parse(row.report_json) as ProfileReport);
      }
      return compareReports(reports[0]!, reports[1]!);
    },
    async excerpts(runId: string, n: number) {
      const row = store.db.prepare('SELECT report_json FROM analysis_run WHERE id=?').get(runId) as { report_json: string } | undefined;
      if (!row) throw new Error('unknown run');
      return (JSON.parse(row.report_json) as ProfileReport).excerpts.slice(0, n);
    },
  });

  // ---- sync bridge: per-account jobs with a session executor ----
  const syncJobs = new Map<string, AccountSyncJob>();
  const checkpoints = new Map<string, Checkpoint>();
  const seenItems = new Map<string, PageItem>(); // `${acct}:${id}`
  const syncStore: SyncStore = {
    upsertListedItems(accountId, items) {
      let inserted = 0, unchanged = 0, conflicts = 0;
      for (const it of items) {
        const key = `${accountId}:${it.id}`;
        const prev = seenItems.get(key);
        if (!prev) { seenItems.set(key, it); inserted++; store.upsertConversation({ accountId, externalRef: it.id, source: 'backfill', observedAt: Date.now() }); }
        else if (prev.contentDigest && it.contentDigest && prev.contentDigest !== it.contentDigest) { conflicts++; seenItems.set(key, { ...it, revision: String(Number(prev.revision ?? 1) + 1) }); }
        else unchanged++;
      }
      return { inserted, unchanged, conflicts };
    },
    recordConflict(accountId, kind, detail) { store.recordConflict(accountId, kind, detail); },
    recordObservation(accountId, kind, payload, at) {
      store.recordObservation({ account_id: accountId, mechanism: 'probe', kind: 'probe_result', observed_at: at, payload, completeness: 'unknown' });
    },
    saveCheckpoint(jobId, cp) { checkpoints.set(jobId, cp); store.db.prepare(`INSERT INTO sync_checkpoint (job_id, seq, cursor_json, page_fingerprint, seen_digest, counts_json, adapter_version, run_seq, committed_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id, seq) DO UPDATE SET cursor_json=excluded.cursor_json, page_fingerprint=excluded.page_fingerprint, seen_digest=excluded.seen_digest, counts_json=excluded.counts_json, run_seq=excluded.run_seq, committed_at=excluded.committed_at`)
      .run(jobId, cp.seq, cp.cursor ?? canonicalJson(null), cp.pageFingerprint, cp.seenDigest, canonicalJson(cp.counts), cp.adapterVersion, cp.runSeq, Date.now()); },
    loadCheckpoint(jobId) { return checkpoints.get(jobId) ?? null; },
    isTurnInFlight(accountId, externalRef) {
      const live = store.db.prepare(`SELECT 1 AS x FROM turn t JOIN branch b ON b.id=t.branch_id JOIN conversation c ON c.id=b.conversation_id
        WHERE c.account_id=? AND c.external_ref=? AND t.completeness='unknown'`).get(accountId, externalRef);
      return live !== undefined;
    },
  };
  const executors = new Map<string, SyncExecutor>();
  const jobStartedAt = new Map<string, number>();
  function persistJobState(job: AccountSyncJob): void {
    const j = job.job;
    const now = Date.now();
    if (!jobStartedAt.has(j.id)) jobStartedAt.set(j.id, now);
    const terminal = ['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(j.state);
    store.db.prepare(`INSERT INTO sync_job (id, account_id, state, blocking_reason, adapter_version, run_seq, started_at, updated_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, blocking_reason=excluded.blocking_reason,
        run_seq=excluded.run_seq, updated_at=excluded.updated_at, finished_at=excluded.finished_at`)
      .run(j.id, j.accountId, j.state, j.blockingReason ?? null, 'v1', j.runSeq, jobStartedAt.get(j.id)!, now, terminal ? now : null);
  }
  service.setSyncBridge({
    async start(accountId: string) {
      const id = newId('job');
      const ex = executors.get(accountId);
      if (!ex) throw new Error('no session executor registered for account (owner must sign in first)');
      syncJobs.set(id, new AccountSyncJob({ accountId, jobId: id, adapterVersion: 'v1' }, { executor: ex, store: syncStore }));
      persistJobState(syncJobs.get(id)!);
      return { job_id: id };
    },
    async status(jobId) { const j = syncJobs.get(jobId); if (!j) throw new Error('unknown job'); return j.job; },
    async pause(jobId) { const j = syncJobs.get(jobId); j?.pause(); if (j) persistJobState(j); return { paused: true }; },
    async resume(jobId) {
      const j = syncJobs.get(jobId);
      if (!j) throw new Error('unknown job');
      const epoch = store.activeEpoch(j.job.accountId);
      if (!epoch) throw new Error('identity re-probe required: no active epoch');
      j.resume();
      persistJobState(j);
      return { resumed: true, reverified_epoch: epoch.id };
    },
    async cancel(jobId) { const j = syncJobs.get(jobId); j?.cancel(); if (j) persistJobState(j); return { cancelled: true }; },
    async coverage(accountId) {
      const counts = store.countsByCompleteness(accountId);
      return {
        account_id: accountId, listing_method: 'qualified_read_or_none', listing_verified_at: 0,
        newest_seen: null, oldest_seen: null,
        items_known: Object.values(counts).reduce((a, b) => a + b, 0),
        items_archived: counts.complete ?? 0, items_complete: counts.complete ?? 0,
        items_partial: (counts.partial_stream ?? 0) + (counts.observer_gap ?? 0),
        items_unknown_content: counts.unknown ?? 0,
        detail_failures: 0, pagination_gaps: [], ownership_conflicts: [], adapter_gaps: [],
        last_run: 0, confidence_statement: 'historical completeness is not claimed without a verified listing',
      };
    },
    async verifyRead(accountId, opId) {
      const j = [...syncJobs.values()].find((x) => x.job.accountId === accountId);
      if (!j) throw new Error('start a job first');
      const epoch = store.activeEpoch(accountId);
      const q = await j.verifyReadOp(opId, { currentEpoch: Boolean(epoch), parsePage: parseArenaListPage });
      return q;
    },
  });

  const supervisor = new CaptureSupervisor({ adapter, service, artifacts, archiveKey });

  // mock view scripts: the adapter is created per openAccountView, so scenarios
  // run by creating views directly; runScriptedTurn wires one turn end-to-end.
  async function runScriptedTurn(accountId: string, script: import('@arena/browser-adapter').ViewScript) {
    const view = await adapter.createAccountView({ accountId, storagePath: `mock://partitions/${accountId}`, allowPopupsSamePartition: true, script });
    await view.attach();
    await view.enableNetwork({ bufferSizeBytes: 1 << 20 });
    await view.enablePage();
    await view.enableRuntime();
    await view.addIsolatedBinding('__ARENA_ARCHIVE__', 'arena-archive');
    await view.addScriptOnNewDocument('/*witness*/', 'arena-archive');
    await view.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
    const epoch = store.beginEpoch(accountId);
    let pipeline = service.pipelineFor(accountId);
    if (!pipeline) { await service.openCapture(accountId); pipeline = service.pipelineFor(accountId)!; }
    pipeline.attachAdapter(view, epoch);
    // (openCapture attaches its own scripted-noop view too; the live pipeline is shared)
    await view.navigate('https://arena.ai/');
    pipeline.drainQueue();
    store.db.transaction(() => { /* normalize commit point (bounded txn) */ });
    const conv = store.db.prepare('SELECT c.id FROM conversation c WHERE c.account_id=? ORDER BY c.rowid DESC LIMIT 1').get(accountId) as { id: string } | undefined;
    if (!conv) return { turnFound: false };
    const br = store.listBranches(conv.id).at(-1);
    const turns = br ? store.getBranchTurns(String(br!.id)) : [];
    const found = turns.at(-1);
    return { turnFound: found !== undefined, detail: found ? store.getTurn(String(found.id)) : undefined };
  }

  return {
    db, store, catalog, adapter, service, supervisor, artifacts, archiveKey, directives, root,
    runScriptedTurn,
    registerSyncExecutor(accountId: string, ex: SyncExecutor) { executors.set(accountId, ex); },
    async runSyncWalk(accountId: string, opId: string) {
      const j = [...syncJobs.values()].find((x) => x.job.accountId === accountId);
      if (!j) throw new Error('no job: call sync_start first');
      const res = await j.walk({ opId, parsePage: parseArenaListPage });
      persistJobState(j);
      return { pages: res.pages, job: { state: res.job.state } };
    },
    async dispose() {
      for (const id of [...service.views.keys()]) service.closeCapture(id);
      db.close();
      if (!opts.root) await rm(root, { recursive: true, force: true });
    },
  };
}

/** page format used by sandbox sync fixtures & owner-qualified demo pages */
export function parseArenaListPage(body: string): { items: PageItem[]; nextCursor: string | null } {
  const o = JSON.parse(body) as { items?: Array<Record<string, unknown>>; next_cursor?: string | null };
  return {
    items: (o.items ?? []).map((it) => ({
      id: String(it.id),
      revision: it.revision !== undefined ? String(it.revision) : undefined,
      contentDigest: it.digest ? String(it.digest) : sha256Hex(canonicalJson(it)),
    })),
    nextCursor: o.next_cursor ?? null,
  };
}

// re-export for gate scripts
export { compareReports, runProfiles, buildCorpus, makeCorpus };
