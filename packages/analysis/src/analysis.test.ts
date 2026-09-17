import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCorpus } from '@arena/fixtures';
import { buildCorpus, runProfiles, compareReports, movingAverageTTR } from './index.ts';

test('corpus snapshot includes only complete turns with observed cohorts; records exclusions', () => {
  const rows = makeCorpus(7, 24);
  const snap = buildCorpus(rows);
  const expectedComplete = rows.filter((r) => r.completeness === 'complete').length;
  assert.ok(expectedComplete > 0);
  assert.equal(snap.rows.length, expectedComplete);
  const totalExcluded = snap.excluded.reduce((s, x) => s + x.n, 0);
  assert.equal(totalExcluded, rows.length - expectedComplete);
});

test('corpus hash is stable and content-sensitive', () => {
  const rows = makeCorpus(11, 12);
  const a = buildCorpus(rows);
  const b = buildCorpus(rows);
  assert.equal(a.corpus_hash, b.corpus_hash);
  const includedIdx = rows.findIndex((r) => r.completeness === 'complete');
  const changed = rows.map((r, i) => i === includedIdx ? { ...r, text: r.text + ' extra' } : r);
  const excludedChange = rows.map((r, i) => i !== includedIdx && r.completeness !== 'complete' ? { ...r, text: r.text + ' !!' } : r);
  const c = buildCorpus(changed);
  assert.notEqual(a.corpus_hash, c.corpus_hash);
  // excluded rows must NOT influence the snapshot hash: they are not part of the corpus
  const partialIdx = rows.findIndex((r) => r.completeness !== 'complete' && r.role === 'assistant');
  if (partialIdx >= 0) {
    const withExcludedChanged = rows.map((r, i) => i === partialIdx ? { ...r, text: r.text + ' !!' } : r);
    assert.equal(buildCorpus(withExcludedChanged).corpus_hash, a.corpus_hash);
  }
});

test('profiles: alpha cohort is measurably more eager-affirming than beta (golden)', () => {
  const rows = makeCorpus(7, 40);
  const snap = buildCorpus(rows);
  const report = runProfiles(snap);
  const alpha = report.per_cohort.alpha!.opener_pattern!.categories!;
  const beta = report.per_cohort.beta!.opener_pattern!.categories!;
  assert.ok((alpha.eager_affirmation ?? 0) > 0);
  assert.equal(beta.eager_affirmation ?? 0, 0);
  assert.ok((beta.hedged_opening ?? 0) > 0);
  assert.equal(alpha.hedged_opening ?? 0, 0);
  // every metric reports sample size
  for (const [id, m] of Object.entries(report.metrics)) {
    assert.equal(typeof m.n, 'number', `metric ${id} lacks n`);
  }
  assert.ok(report.limits.length >= 3);
});

test('MTLD proxy distinguishes repetitive text from diverse text', () => {
  const repetitive = 'the cat sat. '.repeat(60);
  const diverse = makeCorpus(3, 4).map((r) => r.text).join(' ');
  assert.ok(movingAverageTTR(repetitive) < movingAverageTTR(diverse));
});

test('excerpts are deterministic and provenance-linked by turn id', () => {
  const snap = buildCorpus(makeCorpus(9, 20));
  const a = runProfiles(snap).excerpts;
  const b = runProfiles(snap).excerpts;
  assert.deepEqual(a, b);
  assert.ok(a.every((e) => snap.rows.some((r) => r.turn_id === e.turn_id)));
});

test('compare refuses mismatched corpora with explicit reason, never silent mixing', () => {
  const r1 = runProfiles(buildCorpus(makeCorpus(1, 12)));
  const r2 = runProfiles(buildCorpus(makeCorpus(2, 12)));
  const cmp = compareReports(r1, r2);
  assert.equal(cmp.comparable, false);
  assert.match(cmp.reason!, /corpus\/code mismatch/);
  const same = runProfiles(buildCorpus(makeCorpus(1, 12)));
  const ok = compareReports(r1, same);
  assert.equal(ok.comparable, true);
  assert.ok(Object.keys(ok.deltas).length > 5);
});
