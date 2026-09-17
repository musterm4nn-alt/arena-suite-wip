import { canonicalJson, sha256Hex } from '@arena/core';
import type { CorpusTurnRow } from '@arena/fixtures';

/**
 * Deterministic local analysis (plan §13). Operates on immutable corpus
 * snapshots: corpusHash + code version + config version. Default inclusion:
 * `complete` turns whose cohort comes from OBSERVED/REVEALED identity only.
 * Every metric carries sample count + cohort definition. No inference output
 * may ever write back into observed identity (§10.1) — enforced by there
 * being no such write path in this package.
 */

export const ANALYSIS_CODE_VERSION = 'p1';

export interface MetricSpec {
  id: string;
  family: 'structure' | 'lexical' | 'discourse' | 'interactive' | 'variation';
  confounds: string[];
  compute(samples: readonly AnalyzedTurn[]): MetricValue;
}

export interface MetricValue {
  n: number;
  mean?: number;
  median?: number;
  p25?: number;
  p75?: number;
  categories?: Record<string, number>;
}

export interface AnalyzedTurn {
  turn_id: string;
  cohort: string;
  text: string;
  parts: Array<{ kind: string; text?: string }>;
  startedAt: number | null;
  endedAt: number | null;
}

export interface CorpusSnapshot {
  corpus_hash: string;
  rows: AnalyzedTurn[];
  excluded: { reason: string; n: number }[];
}

/** Snapshot: only complete turns, cohort from observed evidence. Deterministic ordering. */
export function buildCorpus(rows: readonly CorpusTurnRow[], opts: { includeCohorts?: string[] } = {}): CorpusSnapshot {
  const included: AnalyzedTurn[] = [];
  const excl = new Map<string, number>();
  for (const r of rows) {
    if (r.role !== 'assistant') continue;
    if (r.completeness !== 'complete') bump(excl, `completeness:${r.completeness}`);
    else if (r.cohort === 'unresolved') bump(excl, 'cohort:unresolved_identity');
    else if (opts.includeCohorts && !opts.includeCohorts.includes(r.cohort)) bump(excl, `cohort:${r.cohort}`);
    else included.push({
      turn_id: r.turn_id, cohort: r.cohort, text: r.text, parts: r.parts,
      startedAt: r.started_at, endedAt: r.ended_at,
    });
  }
  included.sort((a, b) => a.turn_id.localeCompare(b.turn_id));
  const corpus_hash = sha256Hex(canonicalJson({
    turns: included.map((t) => [t.turn_id, sha256Hex(t.text)]),
    code: ANALYSIS_CODE_VERSION,
    config: opts,
  }));
  return { corpus_hash, rows: included, excluded: [...excl.entries()].map(([reason, n]) => ({ reason, n })) };
}

function bump(m: Map<string, number>, k: string): void { m.set(k, (m.get(k) ?? 0) + 1); }

const WORD_RE = /[\p{L}\p{N}']+/u;

export const METRICS: MetricSpec[] = [
  {
    id: 'chars_total', family: 'structure', confounds: ['prompt formatting', 'rendering'],
    compute: (s) => numeric(s.map((t) => t.text.length)),
  },
  {
    id: 'sentences_mean', family: 'structure', confounds: ['prompt length'],
    compute: (s) => numeric(s.map((t) => (t.text.match(/[.!?。]+(?=\s|$)/g) ?? []).length)),
  },
  {
    id: 'paragraphs_mean', family: 'structure', confounds: ['rendering'],
    compute: (s) => numeric(s.map((t) => t.text.split(/\n{2,}/).length)),
  },
  {
    id: 'has_code_block_rate', family: 'structure', confounds: ['task type'],
    compute: (s) => rate(s, (t) => /```/.test(t.text)),
  },
  {
    id: 'has_heading_rate', family: 'structure', confounds: ['task type'],
    compute: (s) => rate(s, (t) => /^#{1,4} /m.test(t.text)),
  },
  {
    id: 'has_list_rate', family: 'structure', confounds: ['task type'],
    compute: (s) => rate(s, (t) => /^\s*([-*]|\d+\.)\s/m.test(t.text)),
  },
  {
    id: 'mtld_proxy', family: 'lexical', confounds: ['topic', 'language'],
    compute: (s) => numeric(s.map((t) => Math.round(movingAverageTTR(t.text) * 10000) / 10000)),
  },
  {
    id: 'punctuation_rate', family: 'lexical', confounds: ['language'],
    compute: (s) => numeric(s.map((t) => round4((t.text.match(/[,.:;]/g) ?? []).length / Math.max(1, t.text.length / 100)))),
  },
  {
    id: 'opener_pattern', family: 'discourse', confounds: ['safety/system prompt'],
    compute: (s) => {
      let eager = 0, hedged = 0, other = 0;
      for (const t of s) {
        const head = t.text.slice(0, 40).toLowerCase();
        if (/^(sure|of course|certainly|absolutely)!?/.test(head)) eager++;
        else if (/^(i (need|think|believe)|perhaps|maybe|let me|let's (see|think)|hmm)/.test(head)) hedged++;
        else other++;
      }
      return { n: s.length, categories: { eager_affirmation: eager, hedged_opening: hedged, other } };
    },
  },
  {
    id: 'hedging_density', family: 'discourse', confounds: ['topic', 'safety prompt'],
    compute: (s) => numeric(s.map((t) => round4(((t.text.match(/\b(perhaps|maybe|possibly|might|could|tends|likely|arguably)\b/gi) ?? []).length) / Math.max(1, countWords(t.text)) * 100))),
  },
  {
    id: 'refusal_rate', family: 'discourse', confounds: ['safety system prompt'],
    compute: (s) => rate(s, (t) => /\bi (can't|cannot|am unable to|won't)\b/i.test(t.text)),
  },
  {
    id: 'reasoning_part_rate', family: 'interactive', confounds: ['harness/mode'],
    compute: (s) => rate(s, (t) => t.parts.some((p) => p.kind === 'reasoning')),
  },
  {
    id: 'completion_latency_ms', family: 'interactive', confounds: ['network', 'queueing'],
    compute: (s) => numeric(s.filter((t) => t.startedAt !== null && t.endedAt !== null).map((t) => t.endedAt! - t.startedAt!)),
  },
];

function countWords(t: string): number { return (t.match(new RegExp(WORD_RE.source, 'gu')) ?? []).length; }

/** Moving-average type-token ratio (approximation of MTLD; deterministic). */
export function movingAverageTTR(text: string, window = 50): number {
  const words = (text.match(new RegExp(WORD_RE.source, 'gu')) ?? []).map((w) => w.toLowerCase());
  if (words.length <= window) {
    const set = new Set(words);
    return words.length === 0 ? 0 : set.size / words.length;
  }
  let sum = 0, n = 0;
  for (let i = 0; i + window <= words.length; i += window >> 1) {
    const slice = words.slice(i, i + window);
    sum += new Set(slice).size / slice.length;
    n++;
  }
  return n ? sum / n : 0;
}

function round4(x: number): number { return Math.round(x * 10000) / 10000; }

function numeric(values: number[]): MetricValue {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  return { n: values.length, mean: round4(mean), median: q(0.5), p25: q(0.25), p75: q(0.75) };
}

function rate(rows: readonly AnalyzedTurn[], pred: (t: AnalyzedTurn) => boolean): MetricValue {
  const hits = rows.filter(pred).length;
  return { n: rows.length, mean: rows.length ? round4(hits / rows.length) : undefined };
}

export interface ProfileReport {
  corpus_hash: string;
  code_version: typeof ANALYSIS_CODE_VERSION;
  cohort_definition: string;
  metrics: Record<string, MetricValue & { confounds: string[] }>;
  per_cohort: Record<string, Record<string, MetricValue>>;
  missingness: { reason: string; n: number }[];
  excerpts: Array<{ turn_id: string; cohort: string; quote: string }>;
  limits: string[];
}

export function runProfiles(corpus: CorpusSnapshot, opts: { includeOnly?: string[] } = {}): ProfileReport {
  const cohorts = [...new Set(corpus.rows.map((r) => r.cohort))].sort();
  const metrics: ProfileReport['metrics'] = {};
  const per_cohort: ProfileReport['per_cohort'] = { __ALL__: {} };
  for (const c of cohorts) per_cohort[c] = {};
  for (const m of METRICS) {
    const rows: AnalyzedTurn[] = opts.includeOnly && opts.includeOnly.length > 0 ? corpus.rows.filter((r) => opts.includeOnly!.includes(r.cohort)) : corpus.rows;
    const base = m.compute(rows);
    metrics[m.id] = { ...base, confounds: m.confounds };
    per_cohort.__ALL__![m.id] = base;
    for (const c of cohorts) {
      const cr = rows.filter((r) => r.cohort === c);
      per_cohort[c]![m.id] = m.compute(cr);
    }
  }
  return {
    corpus_hash: corpus.corpus_hash,
    code_version: ANALYSIS_CODE_VERSION,
    cohort_definition: `cohorts=[${cohorts.join(',')}] from observed/revealed identity evidence; complete turns only`,
    metrics,
    per_cohort,
    missingness: corpus.excluded,
    excerpts: pickExcerpts(corpus, 5),
    limits: [
      'within-user, within-cohort descriptions only (§13.1)',
      'no universal model-behavior claims; no build/authorship attribution',
      'style inference cannot write to observed identity (§10.1)',
    ],
  };
}

/** Deterministic excerpt choice: stride over sorted corpus hashes (reproducible). */
export function pickExcerpts(corpus: CorpusSnapshot, n: number): ProfileReport['excerpts'] {
  const rows = corpus.rows;
  if (rows.length === 0) return [];
  const stride = Math.max(1, Math.floor(rows.length / n));
  const out: ProfileReport['excerpts'] = [];
  for (let i = 0; out.length < n && i < rows.length; i += stride) {
    const r = rows[i]!;
    out.push({ turn_id: r.turn_id, cohort: r.cohort, quote: r.text.slice(0, 160) });
  }
  return out;
}

/** Compare two runs: metric deltas with sample counts; refuses mismatched corpora silently by reporting them. */
export function compareReports(a: ProfileReport, b: ProfileReport): { comparable: boolean; reason?: string; deltas: Record<string, { mean_delta: number | null; a_n: number; b_n: number }> } {
  const comparable = a.corpus_hash === b.corpus_hash && a.code_version === b.code_version;
  const deltas: Record<string, { mean_delta: number | null; a_n: number; b_n: number }> = {};
  for (const id of Object.keys(a.metrics)) {
    const ma = a.metrics[id]!, mb = b.metrics[id];
    if (!mb) continue;
    deltas[id] = {
      mean_delta: ma.mean !== undefined && mb.mean !== undefined ? round4(mb.mean - ma.mean) : null,
      a_n: ma.n, b_n: mb.n,
    };
  }
  return comparable
    ? { comparable: true, deltas }
    : { comparable: false, reason: `corpus/code mismatch (a=${a.corpus_hash.slice(0, 8)} b=${b.corpus_hash.slice(0, 8)}; ${a.code_version}/${b.code_version})`, deltas };
}
