import { ArchiveError, canonicalJson, sha256Hex, type Clock, systemClock } from '@arena/core';

/**
 * Existing-history synchronization (plan §9). Broad rules encoded here:
 * - replay only operations that completed read qualification (§9.1);
 * - checkpoints are transactional; resume never assumes completeness;
 * - one failing account must not degrade another (§2 rule 7);
 * - "synchronized" is a coverage report, never a completeness claim.
 */

export interface PageFetch {
  status: number;
  bodyText: string;
}

/** Executor seam: in production this is the owner-session fetch path; tests inject fakes. */
export interface SyncExecutor {
  fetchPage(opts: { opId: string; cursor: string | null }): Promise<PageFetch>;
  fetchDetail(opts: { opId: string; itemId: string }): Promise<PageFetch>;
  /** Server-visible target fingerprint (e.g. list digest surfaced by API or UI). */
  fingerprint(opts: { opId: string }): Promise<string>;
}

export interface PageItem { id: string; revision?: string; contentDigest?: string }
export interface ParsedPage { items: PageItem[]; nextCursor: string | null }

export interface SyncStore {
  /** Idempotent per-account upsert of listed items. Returns classification counts. */
  upsertListedItems(accountId: string, items: PageItem[], seenAt: number, probeId: string): {
    inserted: number; unchanged: number; conflicts: number;
  };
  recordConflict(accountId: string, kind: string, detail: Record<string, unknown>): void;
  recordObservation(accountId: string, kind: string, payload: unknown, at: number): void;
  saveCheckpoint(jobId: string, cp: Checkpoint): void;
  loadCheckpoint(jobId: string): Checkpoint | null;
  isTurnInFlight(accountId: string, externalRef: string): boolean;
}

export interface Checkpoint {
  seq: number;
  cursor: string | null;
  pageFingerprint: string;
  seenDigest: string;
  counts: { known: number; archived: number };
  adapterVersion: string;
  runSeq: number;
}

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_gaps' | 'failed' | 'cancelled';
export type BlockingReason = 'auth' | 'rate_limit' | 'challenge' | 'drift' | 'account_mismatch' | 'owner_action';

export interface SyncJob {
  id: string;
  accountId: string;
  state: JobState;
  blockingReason?: BlockingReason;
  runSeq: number;
  lastError?: string;
}

export interface ReadQualification {
  opId: string;
  probeId: string;
  qualified: boolean;
  reason: 'ok' | 'mutation_unknown' | 'pagination_instability' | 'detail_mismatch' | 'no_current_epoch' | 'drift_since_probe';
  fingerprint_before: string | null;
  fingerprint_after: string | null;
  observedAt: number;
}

export interface QualificationProbe {
  /** §9.1: exactly one same-session replay; fingerprints must match pre/post. */
  run(opts: { opId: string; currentEpoch: boolean; repeatPage: (cursor: string | null) => Promise<ParsedPage> }): Promise<ReadQualification>;
}

export class SyncScheduler {
  #jobs = new Map<string, SyncJob>();
  #running = new Set<string>();
  #globalConcurrency: number;
  #clock: Clock;

  constructor(store: SyncStore, executor: SyncExecutor, opts: { globalConcurrency?: number; clock?: Clock; rng?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    void store; void executor;
    this.#globalConcurrency = opts.globalConcurrency ?? 2;
    this.#clock = opts.clock ?? systemClock;
  }

  job(id: string): SyncJob | undefined { return this.#jobs.get(id); }
  jobsFor(accountId: string): SyncJob[] { return [...this.#jobs.values()].filter((j) => j.accountId === accountId); }
}

/** Per-account job runner. One queue + checkpoint chain + auth state per account (§5). */
export class AccountSyncJob {
  #job: SyncJob;
  #qual: Map<string, ReadQualification> = new Map(); // opId -> last qualification
  #deps: { executor: SyncExecutor; store: SyncStore; clock: Clock; rng: () => number; sleep: (ms: number) => Promise<void> };
  #cancelled = false;
  #paused = false;
  #overlapItems = 0;
  #detailFailures = 0;
  #paginationInstabilities = 0;
  #newestSeen: number | null = null;
  #oldestSeen: number | null = null;

  constructor(init: { accountId: string; jobId: string; adapterVersion: string }, deps: {
    executor: SyncExecutor; store: SyncStore; clock?: Clock; rng?: () => number; sleep?: (ms: number) => Promise<void>;
  }) {
    this.#job = { id: init.jobId, accountId: init.accountId, state: 'queued', runSeq: 0 };
    this.#adapterVersion = init.adapterVersion;
    this.#deps = {
      executor: deps.executor, store: deps.store,
      clock: deps.clock ?? systemClock, rng: deps.rng ?? Math.random,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  #adapterVersion: string;

  get job(): SyncJob { return { ...this.#job, ...(this.#job.blockingReason ? { blockingReason: this.#job.blockingReason } : {}) }; }
  get qualifications(): ReadQualification[] { return [...this.#qual.values()]; }

  pause(): void { this.#paused = true; if (this.#job.state === 'running') this.#setState('paused', this.#job.blockingReason); }
  resume(): void { this.#paused = false; if (this.#job.state === 'paused') this.#setState('running'); }
  cancel(): void { this.#cancelled = true; this.#setState('cancelled'); }

  #setState(s: JobState, reason?: BlockingReason): void {
    this.#job.state = s;
    if (reason) this.#job.blockingReason = reason; else delete this.#job.blockingReason;
  }

  /** §9.1 read qualification probe. */
  async verifyReadOp(opId: string, input: {
    currentEpoch: boolean;
    parsePage: (body: string) => ParsedPage;
    firstCursor?: string | null;
    detailSampleItemId?: string;
    detailExpectedDigest?: string;
  }): Promise<ReadQualification> {
    const at = this.#deps.clock.now();
    const base: Omit<ReadQualification, 'reason' | 'qualified'> = {
      opId, probeId: `probe_${sha256Hex(`${opId}:${at}`).slice(0, 12)}`,
      fingerprint_before: null, fingerprint_after: null, observedAt: at,
    };
    if (!input.currentEpoch) return { ...base, qualified: false, reason: 'no_current_epoch' };

    // steps 3-5: fingerprint, exactly one replay, fingerprint again
    const fpBefore = await this.#deps.executor.fingerprint({ opId });
    const replay = await this.#deps.executor.fetchPage({ opId, cursor: input.firstCursor ?? null });
    const fpAfter = await this.#deps.executor.fingerprint({ opId });
    if (replay.status === 401 || replay.status === 403) { this.#setState('paused', 'auth'); return { ...base, fingerprint_before: fpBefore, fingerprint_after: fpAfter, qualified: false, reason: 'mutation_unknown' }; }
    if (replay.status === 429) { this.#setState('paused', 'rate_limit'); return { ...base, qualified: false, reason: 'mutation_unknown' }; }
    if (fpBefore !== fpAfter) {
      return { ...base, fingerprint_before: fpBefore, fingerprint_after: fpAfter, qualified: false, reason: 'mutation_unknown' };
    }
    if (replay.status >= 400) {
      // error during the single replay: no baseline established; stay unqualified
      return { ...base, fingerprint_before: fpBefore, fingerprint_after: fpAfter, qualified: false, reason: 'mutation_unknown' };
    }

    // step 6: repeat the SAME page to establish cursor/order stability (§9.1.6)
    const p1 = input.parsePage(replay.bodyText);
    const rep = await this.#deps.executor.fetchPage({ opId, cursor: input.firstCursor ?? null });
    const p1again = input.parsePage(rep.bodyText);
    const ids1 = p1.items.map((x) => x.id).join(',');
    const ids1again = p1again.items.map((x) => x.id).join(',');
    if (ids1 !== ids1again) {
      return { ...base, qualified: false, reason: 'pagination_instability' };
    }
    // also refuse a cursor that cannot advance (sticky pagination) when the page promises more
    if (p1.items.length > 0 && p1.nextCursor !== null && (input.firstCursor ?? null) === p1.nextCursor) {
      return { ...base, qualified: false, reason: 'pagination_instability' };
    }

    // step 7: cross-check one detail read against a live-captured conversation
    if (input.detailSampleItemId && input.detailExpectedDigest) {
      const d = await this.#deps.executor.fetchDetail({ opId, itemId: input.detailSampleItemId });
      if (sha256Hex(d.bodyText) !== input.detailExpectedDigest) {
        return { ...base, qualified: false, reason: 'detail_mismatch' };
      }
    }
    const q: ReadQualification = { ...base, fingerprint_before: fpBefore, fingerprint_after: fpAfter, qualified: true, reason: 'ok' };
    this.#qual.set(opId, q);
    this.#deps.store.recordObservation(this.#job.accountId, 'probe', { kind: 'read_qualification', probeId: q.probeId, opId, fp: fpBefore }, at);
    return q;
  }

  /** Any drift event invalidates qualification until reprobed (§9.1 step 8). */
  invalidateQualification(opId: string): void {
    const q = this.#qual.get(opId);
    if (q) this.#qual.set(opId, { ...q, qualified: false, reason: 'drift_since_probe' });
  }

  /**
   * §9.2 sync walk. Resumes from checkpoint; bounded exponential backoff+jitter
   * for transport/429/5xx only; pauses this account on auth/challenge/drift
   * without touching any other account.
   */
  async walk(input: {
    opId: string;
    parsePage: (body: string) => ParsedPage;
    maxPages?: number;
  }): Promise<{ job: SyncJob; pages: number; coverage: CoverageReport }> {
    const q = this.#qual.get(input.opId);
    if (!q?.qualified) throw new ArchiveError('E_DRIFT', 'operation not read-qualified for replay (run sync_verify_read first)');
    let resumeFrom = this.#deps.store.loadCheckpoint(this.#job.id);
    let cursor = resumeFrom?.cursor ?? null;
    let seq = resumeFrom ? resumeFrom.seq : 0;
    this.#job.runSeq = (resumeFrom?.runSeq ?? 0) + 1;
    this.#setState('running');
    let pages = 0;
    let sawGap = false;

    while (!this.#cancelled) {
      while (this.#paused) await this.#deps.sleep(5);
      if (seq >= (input.maxPages ?? 10_000)) break;
      let fetch: PageFetch;
      try {
        fetch = await this.#deps.executor.fetchPage({ opId: input.opId, cursor });
      } catch (e) {
        const retry = await this.#backoffOrFail(e);
        if (!retry) break;
        continue;
      }
      if (fetch.status === 401 || fetch.status === 403) { this.#setState('paused', 'auth'); break; }
      if (fetch.status === 429 || fetch.status >= 500) {
        const retry = await this.#backoffOrFail({ status: fetch.status });
        if (!retry) break;
        continue;
      }
      if (fetch.status >= 400) { this.#setState('failed'); this.#job.lastError = `http_${fetch.status}`; break; }

      const page = input.parsePage(fetch.bodyText);
      const fingerprint = sha256Hex(canonicalJson(page.items.map((i) => i.id)));
      // checkpoint/overlap stability: compare with the fingerprint recorded at this seq
      if (resumeFrom && resumeFrom.seq === seq && resumeFrom.pageFingerprint !== fingerprint) {
        this.#paginationInstabilities++;
        sawGap = true;
        this.#deps.store.recordConflict(this.#job.accountId, 'pagination_instability', { seq, expected: resumeFrom.pageFingerprint, got: fingerprint });
        // re-walk with a conservative overlap window: step back one page if possible
        seq = Math.max(0, seq - 1);
        cursor = seq === 0 ? null : cursor;
      }
      // live overlap rule: never overwrite an in-flight live turn — defer and reconcile later
      const deferred: PageItem[] = [];
      const persistable: PageItem[] = [];
      for (const it of page.items) {
        if (it.id && this.#deps.store.isTurnInFlight(this.#job.accountId, it.id)) deferred.push(it);
        else persistable.push(it);
      }
      if (deferred.length > 0) sawGap = true;
      const res = this.#deps.store.upsertListedItems(this.#job.accountId, persistable, this.#deps.clock.now(), q.probeId);
      this.#overlapItems += res.conflicts;
      if (res.conflicts > 0) sawGap = true;
      pages++;
      seq++;

      const seenDigest = sha256Hex(canonicalJson(page.items.map((i) => `${i.id}:${i.revision ?? ''}:${i.contentDigest ?? ''}`)));
      this.#deps.store.saveCheckpoint(this.#job.id, {
        seq, cursor: page.nextCursor, pageFingerprint: fingerprint,
        seenDigest, counts: { known: seq, archived: res.inserted + res.unchanged },
        adapterVersion: this.#adapterVersion, runSeq: this.#job.runSeq,
      });
      if (page.nextCursor === null || page.items.length === 0) break;
      if (cursor === page.nextCursor) { // cursor refused to move => instability, stop rather than loop
        this.#paginationInstabilities++;
        sawGap = true;
        this.#setState('completed_with_gaps');
        break;
      }
      cursor = page.nextCursor;
    }
    if (this.#cancelled) this.#setState('cancelled');
    else if (this.#job.state === 'running') this.#setState(sawGap ? 'completed_with_gaps' : 'completed');
    return { job: this.job, pages, coverage: this.coverage('listing_from_qualified_read') };
  }

  async #backoffOrFail(e: unknown): Promise<boolean> {
    const status = (e as { status?: number })?.status;
    if (status === 429 || (typeof status === 'number' && status >= 500)) {
      // bounded retry w/ jitter; never on auth or suspected mutation
      const attempt = ++this.#retryAttempt;
      if (attempt > 5) { this.#setState('failed'); this.#job.lastError = 'rate_limited_exhausted'; return false; }
      const base = Math.min(30_000, 250 * 2 ** attempt);
      const jitter = base * this.#deps.rng();
      await this.#deps.sleep(base + jitter);
      return true;
    }
    this.#setState('failed');
    this.#job.lastError = e instanceof Error ? e.message.slice(0, 200) : 'transport';
    return false;
  }

  #retryAttempt = 0;

  noteDetailFailure(): void { this.#detailFailures++; }

  /** §9.3 "synchronized" is a coverage report. */
  coverage(listingMethod: string): CoverageReport {
    return {
      account_id: this.#job.accountId,
      listing_method: listingMethod,
      listing_verified_at: this.#qual.get('__')?.observedAt ?? this.#deps.clock.now(),
      newest_seen: this.#newestSeen,
      oldest_seen: this.#oldestSeen,
      items_known: 0, // filled by caller from store aggregates
      items_archived: 0,
      items_complete: 0,
      items_partial: 0,
      items_unknown_content: 0,
      detail_failures: this.#detailFailures,
      pagination_gaps: [],
      ownership_conflicts: this.#overlapItems > 0 ? [`${this.#overlapItems} overlap conflicts`] : [],
      adapter_gaps: [],
      last_run: this.#deps.clock.now(),
      confidence_statement: 'coverage report only; historical completeness is not claimed',
    };
  }
}

export interface CoverageReport {
  account_id: string;
  listing_method: string;
  listing_verified_at: number;
  newest_seen: number | null;
  oldest_seen: number | null;
  items_known: number;
  items_archived: number;
  items_complete: number;
  items_partial: number;
  items_unknown_content: number;
  detail_failures: number;
  pagination_gaps: string[];
  ownership_conflicts: string[];
  adapter_gaps: string[];
  last_run: number;
  confidence_statement: string;
}
