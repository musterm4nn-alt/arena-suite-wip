import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock, sha256Hex, canonicalJson } from '@arena/core';
import { AccountSyncJob, type PageFetch, type ParsedPage, type SyncExecutor, type SyncStore, type Checkpoint, type PageItem } from './engine.ts';

class FakeExecutor implements SyncExecutor {
  pages = new Map<string, string | null>(); // cursor -> body; null = end
  details = new Map<string, string>();
  listDigest = 'digest-v1';
  fetchCalls: Array<{ opId: string; cursor: string | null }> = [];
  mutateOnReplay = false;
  failNext: number | 'throw' | null = null;

  async fetchPage({ opId, cursor }: { opId: string; cursor: string | null }): Promise<PageFetch> {
    this.fetchCalls.push({ opId, cursor });
    if (this.failNext === 'throw') { this.failNext = null; throw new Error('net::ERR_CONNECTION_RESET'); }
    if (typeof this.failNext === 'number') { const s = this.failNext; this.failNext = null; return { status: s, bodyText: '' }; }
    const before = this.listDigest;
    const body = this.pages.get(cursor ?? '') ?? null;
    if (this.mutateOnReplay) this.listDigest = before + '#mutated';
    if (body === null) return { status: 404, bodyText: '' };
    return { status: 200, bodyText: body };
  }
  async fetchDetail({ itemId }: { opId: string; itemId: string }): Promise<PageFetch> {
    const body = this.details.get(itemId);
    return body === undefined ? { status: 404, bodyText: '' } : { status: 200, bodyText: body };
  }
  async fingerprint(): Promise<string> { return this.listDigest; }

  static page(items: PageItem[], next: string | null): string {
    return canonicalJson({ items, next_cursor: next });
  }
}

class MemStore implements SyncStore {
  items = new Map<string, PageItem>();
  conflicts: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  observations: Array<{ kind: string; payload: unknown }> = [];
  checkpoints = new Map<string, Checkpoint>();
  inFlight = new Set<string>();

  upsertListedItems(accountId: string, items: PageItem[], _seenAt: number): { inserted: number; unchanged: number; conflicts: number } {
    let inserted = 0, unchanged = 0, conflicts = 0;
    for (const it of items) {
      const key = `${accountId}:${it.id}`;
      const prev = this.items.get(key);
      if (!prev) { this.items.set(key, it); inserted++; }
      else if (prev.contentDigest && it.contentDigest && prev.contentDigest !== it.contentDigest) { conflicts++; this.items.set(key, { ...it, revision: String(Number(prev.revision ?? 1) + 1) }); }
      else unchanged++;
    }
    return { inserted, unchanged, conflicts };
  }
  recordConflict(accountId: string, kind: string, detail: Record<string, unknown>): void { this.conflicts.push({ kind, detail: { account: accountId, ...detail } }); }
  recordObservation(_accountId: string, kind: string, payload: unknown): void { this.observations.push({ kind, payload }); }
  saveCheckpoint(jobId: string, cp: Checkpoint): void { this.checkpoints.set(jobId, cp); }
  loadCheckpoint(jobId: string): Checkpoint | null { return this.checkpoints.get(jobId) ?? null; }
  isTurnInFlight(_accountId: string, externalRef: string): boolean { return this.inFlight.has(externalRef); }
}

function parse(body: string): ParsedPage {
  const o = JSON.parse(body) as { items: PageItem[]; next_cursor: string | null };
  return { items: o.items, nextCursor: o.next_cursor };
}

function mkjob(opts: { clock?: ManualClock; rng?: () => number } = {}) {
  const ex = new FakeExecutor();
  const st = new MemStore();
  const clock = opts.clock ?? new ManualClock(1000);
  const job = new AccountSyncJob({ accountId: 'acct1', jobId: 'job1', adapterVersion: 'v1' }, {
    executor: ex, store: st, clock, rng: opts.rng ?? (() => 0), sleep: async (ms: number) => { clock.advance(ms); },
  });
  return { ex, st, job, clock };
}

test('read qualification: fingerprint equivalence + cursor stability pass', async () => {
  const { ex, job, st } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'c1' }, { id: 'c2' }], 'cur2'));
  ex.pages.set('cur2', FakeExecutor.page([{ id: 'c3' }], null));
  const q = await job.verifyReadOp('op_hist', { currentEpoch: true, parsePage: parse });
  assert.equal(q.qualified, true);
  assert.equal(q.reason, 'ok');
  assert.equal(st.observations.length, 1);
});

test('qualification fails closed when replay mutates server state fingerprint', async () => {
  const { ex, job } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'c1' }], null));
  ex.mutateOnReplay = true;
  const q = await job.verifyReadOp('op_hist', { currentEpoch: true, parsePage: parse });
  assert.equal(q.qualified, false);
  assert.equal(q.reason, 'mutation_unknown');
});

test('walk refuses unqualified ops (HTTP GET is not enough)', async () => {
  const { job } = mkjob();
  await assert.rejects(() => job.walk({ opId: 'op_hist', parsePage: parse }), /not read-qualified/);
});

test('walk: pages checkpointed; resume continues at cursor', async () => {
  const { ex, job, st } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'a' }], 'p2'));
  ex.pages.set('p2', FakeExecutor.page([{ id: 'b' }], 'p3'));
  ex.pages.set('p3', FakeExecutor.page([{ id: 'c' }], null));
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  const r1 = await job.walk({ opId: 'op', parsePage: parse, maxPages: 2 });
  assert.equal(r1.pages, 2);
  assert.equal(job.job.state, 'completed');
  const cp = st.checkpoints.get('job1')!;
  assert.equal(cp.seq, 2);
  assert.equal(cp.cursor, 'p3');
  // resume completes
  const r2 = await job.walk({ opId: 'op', parsePage: parse, maxPages: 10 });
  assert.equal(r2.pages, 1);
  assert.equal(st.items.size, 3);
});

test('live overlap: in-flight conversation is deferred, not overwritten', async () => {
  const { ex, job, st } = mkjob();
  st.inFlight.add('b');
  ex.pages.set('', FakeExecutor.page([{ id: 'a' }], 'p2'));
  ex.pages.set('p2', FakeExecutor.page([{ id: 'b' }, { id: 'c' }], null));
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  const r = await job.walk({ opId: 'op', parsePage: parse });
  assert.equal(st.items.has('acct1:b'), false);
  assert.equal(st.items.has('acct1:c'), true);
  assert.equal(r.job.state, 'completed_with_gaps');
});

test('changed content across overlap becomes new observation/conflict, never silent', async () => {
  const { ex, job, st } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'a', revision: '1', contentDigest: 'h1' }, { id: 'b', revision: '1', contentDigest: 'h1' }], null));
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  await job.walk({ opId: 'op', parsePage: parse });
  ex.pages.set('', FakeExecutor.page([{ id: 'a', revision: '2', contentDigest: 'CHANGED' }], null));
  st.checkpoints.delete('job1'); // force re-walk page 1
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  await job.walk({ opId: 'op', parsePage: parse });
  assert.equal(job.coverage('listing').ownership_conflicts.length, 1);
  assert.equal(st.items.get('acct1:a')?.revision, '2');
});

test('cursor instability stops the walk rather than looping forever', async () => {
  const { ex, job } = mkjob();
  const same = FakeExecutor.page([{ id: 'z' }], 'sticky');
  ex.pages.set('', same);
  ex.pages.set('sticky', same);
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  const r = await job.walk({ opId: 'op', parsePage: parse, maxPages: 50 });
  assert.equal(r.job.state, 'completed_with_gaps');
  assert.equal(r.pages <= 2, true);
});

test('auth expiry pauses this account only; other accounts keep running', async () => {
  const { ex, job } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'a' }], 'p2'));
  ex.pages.set('p2', FakeExecutor.page([{ id: 'b' }], null));
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  const other = mkjob();
  other.ex.pages.set('', FakeExecutor.page([{ id: 'x' }], null));
  await other.job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  // first page ok, then auth drops
  ex.failNext = 403;
  const p = job.walk({ opId: 'op', parsePage: parse, maxPages: 10 });
  await other.job.walk({ opId: 'op', parsePage: parse });
  const r = await p;
  assert.equal(r.job.state, 'paused');
  assert.equal(r.job.blockingReason, 'auth');
  assert.equal(other.job.job.state, 'completed'); // B untouched
});

test('429 retries with bounded backoff; auth failures never retry', async () => {
  const clock = new ManualClock(0);
  const { ex, job } = mkjob({ clock });
  ex.pages.set('', FakeExecutor.page([{ id: 'a' }], null));
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  ex.failNext = 429;
  await job.walk({ opId: 'op', parsePage: parse });
  assert.ok(clock.now() >= 500, 'slept with backoff');
  const m2 = mkjob({ clock });
  m2.ex.pages.set('', FakeExecutor.page([{ id: 'q' }], null));
  await m2.job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  m2.ex.failNext = 404; // auth-adjacent hard failure: failed immediately, no retry loop
  const before = clock.now();
  await m2.job.walk({ opId: 'op', parsePage: parse });
  assert.equal(m2.job.job.state, 'failed');
  assert.equal(clock.now(), before);
});

test('drift invalidates qualification until reprobed', async () => {
  const { ex, job } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'a' }], null));
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  await job.walk({ opId: 'op', parsePage: parse }); // ok
  job.invalidateQualification('op');
  await assert.rejects(() => job.walk({ opId: 'op', parsePage: parse }), /not read-qualified/);
});

test('coverage report is explicit about what it does not claim', async () => {
  const { ex, job } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'a' }], null));
  await job.verifyReadOp('op', { currentEpoch: true, parsePage: parse });
  const { coverage } = await job.walk({ opId: 'op', parsePage: parse });
  assert.match(coverage.confidence_statement, /not claimed/);
  assert.deepEqual(coverage.pagination_gaps, []);
  assert.equal(typeof coverage.items_archived, 'number');
});

test('detail cross-check failure blocks autonomous replay', async () => {
  const { ex, job } = mkjob();
  ex.pages.set('', FakeExecutor.page([{ id: 'a' }], null));
  ex.details.set('a', 'server body');
  const q = await job.verifyReadOp('op', {
    currentEpoch: true, parsePage: parse,
    detailSampleItemId: 'a', detailExpectedDigest: sha256Hex('live captured body'), // mismatch
  });
  assert.equal(q.qualified, false);
  assert.equal(q.reason, 'detail_mismatch');
});
