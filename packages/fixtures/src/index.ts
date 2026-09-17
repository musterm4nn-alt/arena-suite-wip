import { sha256Hex } from '@arena/core';

/**
 * Synthetic protocol fixtures. These model *documented transport shapes*
 * (SSE, NDJSON, WebSocket, RSC-like Flight rows) — they are explicitly NOT
 * captures of Arena traffic, and nothing here may be presented as owner-session
 * evidence (plan §19 evidence policy).
 */

export interface FixtureTurn {
  prompt: string;
  answer: string;
  reasoning?: string;
  modelLabel: string;
}

export interface BattleStreamOpts {
  mode?: 'battle' | 'direct' | 'side_by_side';
  conv?: string;
  secondModelLabel?: string;
  revealed?: Record<number, string>; // position -> revealed name after vote
}

/** SSE stream body as a battle turn might be delivered (synthetic shape). */
export function sseBattleStream(turn: FixtureTurn, opts: BattleStreamOpts = {}): string {
  const ev = (o: Record<string, unknown>) => `data: ${JSON.stringify(o)}\n\n`;
  const parts: string[] = [];
  const meta: Record<string, unknown> = { t: 'meta', model: turn.modelLabel, conv: opts.conv ?? 'c1' };
  if (opts.mode === 'battle') {
    meta.mode = 'battle';
    meta.participants = [
      { position: 0, blind_label: 'Model A', displayed_name: turn.modelLabel },
      { position: 1, blind_label: 'Model B', displayed_name: opts.secondModelLabel ?? 'second-model' },
    ];
  }
  parts.push(ev(meta));
  if (turn.reasoning) {
    for (const w of chunkWords(turn.reasoning)) parts.push(ev({ t: 'reasoning', text: w }));
  }
  for (const w of chunkWords(turn.answer)) parts.push(ev({ t: 'delta', text: w }));
  if (opts.revealed) {
    parts.push(ev({ t: 'vote', revealed: opts.revealed, selected_position: 0 }));
  }
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

/** NDJSON stream (Direct mode, synthetic). */
export function ndjsonDirectStream(turn: FixtureTurn): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'start', model: turn.modelLabel }));
  for (const w of chunkWords(turn.answer)) lines.push(JSON.stringify({ type: 'delta', text: w }));
  lines.push(JSON.stringify({ type: 'end' }));
  lines.push('[DONE]');
  return lines.map((l) => l + '\n').join('');
}

/**
 * RSC-like Flight payload: numeric-id rows, some multi-line. Shape only;
 * real flight encoding is pinned by the discovery gate, not here.
 */
export function rscFlightSample(conversationJson: unknown): string {
  const rows = [
    `1:${JSON.stringify({ type: 'div', children: '2' })}\n`,
    `2:${JSON.stringify({ type: 'pre', children: '3' })}\n`,
    `3:I["${sha256Hex(canonical(conversationJson)).slice(0, 12)}",${JSON.stringify(conversationJson)},"conversation",{},{}`
  ];
  return rows.join('');
}

function canonical(v: unknown): string { try { return JSON.stringify(v); } catch { return ''; } }

/** Word-ish chunker so streams contain many small records with unicode. */
export function chunkWords(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (ch === ' ' || cur.length >= 7) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Split a string's UTF-8 bytes into fixed-size chunks (bytes, not chars). */
export function splitBytes(text: string, size: number): Uint8Array[] {
  const b = Buffer.from(text, 'utf8');
  const out: Uint8Array[] = [];
  for (let i = 0; i < b.length; i += size) out.push(new Uint8Array(b.subarray(i, i + size)));
  return out;
}

export function splitEveryByte(text: string): Uint8Array[] { return splitBytes(text, 1); }

/** Split at the given byte offsets (relative, sorted) — for boundary torture tests. */
export function splitAtOffsets(text: string, offsets: number[]): Uint8Array[] {
  const b = Buffer.from(text, 'utf8');
  const pts = [0, ...offsets.map((o) => Math.max(0, Math.min(b.length, o))).sort((x, y) => x - y), b.length];
  const out: Uint8Array[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, z = pts[i]!;
    if (z > a) out.push(new Uint8Array(b.subarray(a, z)));
  }
  return out;
}

/**
 * Deterministic corpus generator for analysis golden tests: two cohorts with
 * different, *known* style traits so metric correctness is verifiable.
 */
export interface CorpusTurnRow {
  turn_id: string;
  account_id: string;
  conversation_id: string;
  completeness: 'complete' | 'partial_stream' | 'observer_gap' | 'stopped_by_user';
  cohort: string;
  role: 'user' | 'assistant';
  text: string;
  parts: Array<{ kind: string; text?: string }>;
  started_at: number;
  ended_at: number;
}

export function makeCorpus(seed = 7, count = 24): CorpusTurnRow[] {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const rows: CorpusTurnRow[] = [];
  const alphaOpeners = ['Sure! ', 'Of course! ', 'Certainly! '];   // eager style
  const betaOpeners = ['Let me think. ', 'I need to consider this. ', 'Hmm. ']; // hedging style
  for (let i = 0; i < count; i++) {
    const cohort: 'alpha' | 'beta' = i % 2 === 0 ? 'alpha' : 'beta';
    const openers = cohort === 'alpha' ? alphaOpeners : betaOpeners;
    const opener = openers[Math.floor(rnd() * openers.length)]!;
    const sentences = 2 + Math.floor(rnd() * (cohort === 'alpha' ? 2 : 5));
    const body = Array.from({ length: sentences }, (_, k) =>
      `Point ${k + 1} about topic ${Math.floor(rnd() * 9)} ${cohort === 'beta' ? 'perhaps possibly maybe' : 'directly plainly clearly'}.`
    ).join(' ');
    const text = opener + body;
    const completeness = i % 9 === 0 ? 'partial_stream' : i % 11 === 0 ? 'observer_gap' : i % 13 === 0 ? 'stopped_by_user' : 'complete';
    rows.push({
      turn_id: `t${i}`, account_id: 'acct_fix', conversation_id: `c${i % 6}`,
      completeness: completeness as CorpusTurnRow['completeness'],
      cohort, role: 'assistant', text,
      parts: [{ kind: 'text', text }],
      started_at: 1700000000000 + i * 5000,
      ended_at: 1700000000000 + i * 5000 + 900 + Math.floor(rnd() * 4000),
    });
  }
  return rows;
}

/** Golden answer for the assembler given a known stream + split policy. */
export function goldenBodyDigest(text: string): string {
  return sha256Hex(text);
}
