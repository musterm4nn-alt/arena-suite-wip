import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@arena/core';
import type { WitnessMessage } from '@arena/schema';
type WitnessLike = Pick<WitnessMessage, 'v'> & Partial<WitnessMessage>;
import {
  Utf8StreamDecoder, LineBuffer, StreamAssembler, CaptureQueue, EventRouter,
  decideCompleteness, canPromote, verifyAttachBeforeNavigate, reconcileWireWithWitness,
  SseParser, NdjsonParser, WsLedger,
  type ProtocolStep, type SseRecord,
} from './index.ts';

/** Deterministic PRNG for split-boundary fuzzing (pins reproducibility). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HARD_TEXT = 'héllo — “quotes” ünïcode 🚀🧪 中文字符 ☃️ mixed 👨‍👩‍👧‍👦 family emoji + é\n';

test('UTF-8 decode is exact under every possible single split point', () => {
  const bytes = Buffer.from(HARD_TEXT, 'utf8');
  for (let cut = 0; cut <= bytes.length; cut++) {
    const d = new Utf8StreamDecoder();
    const a = d.push(bytes.subarray(0, cut));
    const b = d.push(bytes.subarray(cut));
    const { tail } = d.finish();
    assert.equal(a + b + tail, HARD_TEXT, `split at ${cut}`);
  }
});

test('UTF-8 decode is exact under random multi-splits (200 trials)', () => {
  const bytes = Buffer.from(HARD_TEXT.repeat(8), 'utf8');
  const rnd = mulberry32(1337);
  for (let trial = 0; trial < 200; trial++) {
    const d = new Utf8StreamDecoder();
    let text = '';
    let i = 0;
    while (i < bytes.length) {
      const len = 1 + Math.floor(rnd() * 13);
      text += d.push(bytes.subarray(i, Math.min(bytes.length, i + len)));
      i += len;
    }
    const { tail } = d.finish();
    assert.equal(text + tail, HARD_TEXT.repeat(8));
  }
});

test('truncated multibyte at end is reported, not hidden', () => {
  const bytes = Buffer.from('abcé', 'utf8').subarray(0, 4); // cut inside é (é is 2 bytes)
  const d = new Utf8StreamDecoder();
  d.push(bytes);
  const r = d.finish();
  assert.equal(r.truncated, true);
});

test('line buffer splits logical records at every boundary', () => {
  const full = 'data: one\ndata: two\n\ndata: three\n\n';
  const b16 = Buffer.from(full, 'utf8');
  const out: string[] = [];
  const lb = new LineBuffer();
  for (let c = 0; c < b16.length; c++) lb.push(lbText(b16.subarray(c, c + 1)), (line) => out.push(line));
  lb.flush((l) => out.push(l));
  assert.deepEqual(out.filter((x) => x !== ''), ['data: one', 'data: two', 'data: three']);

  function lbText(b: Uint8Array): string { return Buffer.from(b).toString('utf8'); }
});

test('SSE parser: [DONE] detection and split records', () => {
  const recs: SseRecord[] = [];
  const p = new SseParser((r) => recs.push(r));
  const stream = 'event: message\ndata: {"a":1}\n\ndata: {"b":2\ndata: }\n\ndata: [DONE]\n\n';
  for (const ch of stream) p.push(ch);
  const fin = p.finish();
  assert.equal(fin.cleanClose, true);
  assert.equal(recs.length, 3);
  assert.equal(recs[1]!.data, '{"b":2\n}');
  assert.equal(recs[2]!.isDone, true);
});

test('SSE parser: unterminated record at stream close is a dirty close', () => {
  const recs: SseRecord[] = [];
  const p = new SseParser((r) => recs.push(r));
  p.push('data: partial');
  const fin = p.finish();
  assert.equal(fin.cleanClose, false);
});

test('NDJSON parser tolerates split lines and hides raw unparseable content', () => {
  const lines: unknown[] = [];
  const p = new NdjsonParser((r) => lines.push(r));
  const text = '{"i":0}\n{"i":1}\n[DO';
  for (let i = 0; i < text.length; i += 3) p.pushText(text.slice(i, i + 3));
  p.pushText('NE]\n');
  const fin = p.finish();
  assert.equal(fin.parsed, 2);
  assert.equal(fin.sawDone, true);
  const recs = lines as ({ ok: boolean; line?: string } | { ok: boolean; value: unknown })[];
  assert.ok(recs.every((r) => r.ok !== false || (r as { line: string }).line === '[DONE]' || (r as { line: string }).line === '<unparseable>'));
});

function chunkSplit(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

test('assembler: chunk size 1..len yields identical body hash and text', () => {
  const body = Buffer.from('The quick brown fox jumps over the lazy dog. 🦊 '.repeat(20), 'utf8');
  const full = new StreamAssembler({ maxAssembledBytes: 1 << 20 });
  full.begin('r0', { accountId: 'a' });
  full.appendChunk('r0', { seq: 0, bytes: body, at: 1 });
  full.transportFinished('r0', 2);
  const base = full.finalize('r0');

  for (let size = 1; size <= 40; size++) {
    const asm = new StreamAssembler({ maxAssembledBytes: 1 << 20 });
    asm.begin(`r${size}`, { accountId: 'a' });
    let seq = 0;
    for (const c of chunkSplit(body, size)) asm.appendChunk(`r${size}`, { seq: seq++, bytes: new Uint8Array(c), at: seq });
    asm.transportFinished(`r${size}`, 99);
    const out = asm.finalize(`r${size}`);
    assert.equal(out.record.bodySha256, base.record.bodySha256, `size ${size}`);
    assert.equal(out.text, base.text, `size ${size}`);
    assert.equal(out.record.chunkCount, Math.ceil(body.length / size));
  }
  assert.equal(base.text, body.toString('utf8'));
});

test('assembler: duplicate replays counted, never appended twice', () => {
  const asm = new StreamAssembler({ maxAssembledBytes: 1 << 20 });
  asm.begin('r', { accountId: 'a' });
  const c = new Uint8Array(Buffer.from('chunkA'));
  asm.appendChunk('r', { seq: 0, bytes: c, at: 1 });
  asm.appendChunk('r', { seq: 0, bytes: c, at: 2 }); // replay same seq+content
  asm.appendChunk('r', { seq: 0, bytes: c, at: 3, dedupeKey: 'evt-1' });
  asm.appendChunk('r', { seq: 1, bytes: new Uint8Array(Buffer.from('chunkB')), at: 4 });
  asm.transportFinished('r', 5);
  const { record, text } = asm.finalize('r');
  assert.equal(text, 'chunkAchunkB');
  assert.equal(record.duplicateCount, 2);
  assert.equal(record.chunkCount, 2);
  assert.equal(record.receivedBytes, record.assembledBytes + c.length * 2);
});

test('assembler: gap intervals and out-of-order recorded', () => {
  const asm = new StreamAssembler({ maxAssembledBytes: 1 << 20 });
  asm.begin('r', { accountId: 'a' });
  asm.appendChunk('r', { seq: 0, bytes: new Uint8Array(Buffer.from('A')), at: 1 });
  asm.appendChunk('r', { seq: 5, bytes: new Uint8Array(Buffer.from('B')), at: 2 }); // 1..4 missing
  asm.appendChunk('r', { seq: 3, bytes: new Uint8Array(Buffer.from('C')), at: 3 }); // late, out-of-order
  asm.transportFinished('r', 4);
  const { record } = asm.finalize('r');
  assert.deepEqual(record.gapIntervals, [{ fromSeq: 1, toSeq: 4 }]);
  assert.deepEqual(record.outOfOrderSeqs, [3]);
  assert.equal(record.gapCount, 1);
});

test('assembler: late bytes after finalize counted, body immutable', () => {
  const asm = new StreamAssembler({ maxAssembledBytes: 1 << 20 });
  asm.begin('r', { accountId: 'a' });
  asm.appendChunk('r', { seq: 0, bytes: new Uint8Array(Buffer.from('good')), at: 1 });
  asm.transportFinished('r', 2);
  const first = asm.finalize('r');
  asm.appendChunk('r', { seq: 1, bytes: new Uint8Array(Buffer.from('late')), at: 3 });
  const snap = asm.snapshot('r');
  assert.ok(snap, 'sealed record retained so late bytes are attributable');
  assert.equal(snap!.bodySha256, first.record.bodySha256, 'body hash unchanged');
  assert.equal(snap!.receivedBytes, first.record.receivedBytes + 4, 'late bytes counted');
  assert.equal(snap!.assembledBytes, first.record.assembledBytes, 'assembled bytes unchanged');
  assert.deepEqual(asm.activeRequestIds(), []);
  assert.deepEqual(asm.sealedRequestIds(), ['r']);
});

test('queue: overflow creates explicit gaps and protects terminal events', () => {
  const q = new CaptureQueue(4);
  let gaps = 0;
  q.onGap(() => { gaps++; });
  for (let i = 0; i < 6; i++) q.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'chunk', observed_at: i } as never);
  assert.equal(q.metrics.dropped, 2);
  assert.ok(gaps >= 1);
  // terminal survives even when full of chunks
  const q2 = new CaptureQueue(2);
  q2.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'chunk', observed_at: 1 } as never);
  q2.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'chunk', observed_at: 2 } as never);
  const ok = q2.push({ account_id: 'a', mechanism: 'cdp_network', kind: 'stream_end', observed_at: 3 } as never);
  assert.equal(ok, true);
  const drained = q2.drain(10);
  assert.ok(drained.some((d) => d.kind === 'stream_end'));
  assert.equal(q2.metrics.highWater, 2);
});

test('router: account id stamped from bindings only; page claims ignored', () => {
  const r = new EventRouter();
  r.bind('s1', 't1', { account_id: 'acct_A', session_epoch_id: 'e1', kind: 'page' });
  const out = r.route({ mechanism: 'cdp_network', kind: 'request', observed_at: 5 }, { sessionId: 's1', targetId: 't1', pageClaimedAccountId: 'acct_B' });
  assert.ok(out && out.unbound === false && out.event.account_id === 'acct_A');
  // child target inherits parent's account via flatten
  assert.equal(r.bindChild('s2', 't2', 't1', 'dedicated_worker'), true);
  const out2 = r.route({ mechanism: 'cdp_network', kind: 'chunk', observed_at: 6 }, { sessionId: 's2' });
  assert.ok(out2 && out2.event.account_id === 'acct_A' && out2.event.session_epoch_id === 'e1');
  // unknown parent => refused
  assert.equal(r.bindChild('s3', 't3', 't999', 'iframe'), false);
  // unbound events never receive a page-supplied account
  const out3 = r.route({ mechanism: 'cdp_network', kind: 'chunk', observed_at: 7, payload: { account_id: 'ACCT_FROM_PAGE' } }, { sessionId: 'nope' });
  assert.ok(out3 && out3.unbound === true && out3.event.account_id === 'unbound');
  assert.deepEqual((out3!.event.payload as Record<string, unknown>), { account_id: 'ACCT_FROM_PAGE' }); // payload inert, not authoritative
});

test('completeness reducer: every §7 row exercised', () => {
  assert.equal(decideCompleteness({ transportFinished: true, parserTerminal: true }), 'complete');
  assert.equal(decideCompleteness({ transportFinished: true, parserTerminal: true, observerGap: [{ reason: 'queue_overflow' }] }), 'observer_gap');
  assert.equal(decideCompleteness({ userAbortEvidence: true }), 'stopped_by_user');
  assert.equal(decideCompleteness({ transportFailed: { reason: 'net::ERR_...' } }), 'failed_transport');
  assert.equal(decideCompleteness({ contentPresent: true }), 'partial_stream');
  assert.equal(decideCompleteness({ onlyUiEvidence: true }), 'reconstructed_ui_only');
  assert.equal(decideCompleteness({ imported: true }), 'imported');
  assert.equal(decideCompleteness({}), 'unknown');
});

test('context loss without content is observer_gap, with content is partial_stream', () => {
  assert.equal(decideCompleteness({ contextLoss: { reason: 'renderer_gone' }, contentPresent: true }), 'partial_stream');
  assert.equal(decideCompleteness({ contextLoss: { reason: 'renderer_gone' } }), 'observer_gap');
  assert.equal(decideCompleteness({ transportFailed: { reason: 'x' }, contentPresent: true }), 'failed_transport');
});

test('promotion: only unambiguous same-scope complete history reconciles', () => {
  const turn = { account_id: 'a', conversation_id: 'c', branch_id: 'b', revision: 'r1' };
  assert.deepEqual(
    canPromote({ current: 'partial_stream', historyTurn: turn, liveTurn: turn, historyCompleteness: 'complete', contentDigestLive: 'x', contentDigestHistory: 'x' }),
    { promote: true, reason: 'reconciled' }
  );
  assert.deepEqual(
    canPromote({ current: 'partial_stream', historyTurn: { ...turn, revision: 'r2' }, liveTurn: turn, historyCompleteness: 'complete', contentDigestLive: 'x', contentDigestHistory: 'x' }),
    { promote: false, reason: 'scope_mismatch' }
  );
  assert.deepEqual(
    canPromote({ current: 'partial_stream', historyTurn: turn, liveTurn: turn, historyCompleteness: 'unknown', contentDigestLive: 'x', contentDigestHistory: 'x' }),
    { promote: false, reason: 'history_not_complete' }
  );
  assert.deepEqual(
    canPromote({ current: 'partial_stream', historyTurn: turn, liveTurn: turn, historyCompleteness: 'complete', contentDigestLive: 'x', contentDigestHistory: 'y' }),
    { promote: false, reason: 'content_mismatch' }
  );
  assert.deepEqual(
    canPromote({ current: 'complete', historyTurn: turn, liveTurn: turn, historyCompleteness: 'complete', contentDigestLive: 'x', contentDigestHistory: 'x' }),
    { promote: false, reason: 'state_not_promotable' }
  );
});

function steps(navUrl = 'https://arena.ai/'): ProtocolStep[] {
  return [
    { step: 'create_account_view', account_id: 'a1', at: 1 },
    { step: 'bind_account', account_id: 'a1', at: 2 },
    { step: 'create_capture_queue', account_id: 'a1', at: 3 },
    { step: 'debugger_attach', account_id: 'a1', at: 4 },
    { step: 'domain_enable', domain: 'Network', ack: true, at: 5 },
    { step: 'domain_enable', domain: 'Page', ack: true, at: 5 },
    { step: 'domain_enable', domain: 'Runtime', ack: true, at: 5 },
    { step: 'add_binding', name: '__ARENA_ARCHIVE__', isolatedWorld: true, at: 6 },
    { step: 'add_script_to_evaluate_on_new_document', world: 'arena-archive', at: 7 },
    { step: 'set_auto_attach', autoAttach: true, flatten: true, waitForDebuggerOnStart: true, at: 8 },
    { step: 'navigate', url: navUrl, at: 9 },
  ];
}

test('attach protocol: happy path passes', () => {
  const r = verifyAttachBeforeNavigate(steps());
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.measured.firstNavWasArena, true);
});

test('attach protocol: navigations before enable/attach fail', () => {
  const s = steps();
  const navIdx = s.findIndex((x) => x.step === 'navigate');
  const nav = s[navIdx]!;
  s.splice(navIdx, 1);
  s.unshift(nav);
  const r = verifyAttachBeforeNavigate(s);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('AFTER navigation')));
});

test('attach protocol: missing ack, page-world binding, non-flatten, bad url all fail', () => {
  const s = steps().map((x) => x.step === 'domain_enable' ? { ...x, ack: false } : x);
  assert.equal(verifyAttachBeforeNavigate(s).ok, false);
  const s2 = steps().map((x) => x.step === 'add_binding' ? { ...x, isolatedWorld: false } : x);
  assert.ok(verifyAttachBeforeNavigate(s2).failures.some((f) => f.includes('isolated-world')));
  const s3 = steps().map((x) => x.step === 'set_auto_attach' ? { ...x, flatten: false as never } : x);
  assert.ok(verifyAttachBeforeNavigate(s3).failures.some((f) => f.includes('flatten')));
  assert.equal(verifyAttachBeforeNavigate(steps('https://evil.example/')).ok, false);
});

test('reconciler: identical evidence agrees; tampered UI creates conflict, not silent fix', () => {
  const wireText = 'Response body';
  const wire = {
    assembledTextDigest: sha256Hex(wireText), partCount: 1, order: ['p1'], terminal: true,
    participantLabels: [{ position: 0, label: 'Model A' }],
  };
  const w = { v: 1, participants: [{ position: 0, blind_label: 'Model A' }], stop_error_state: 'none' } as WitnessLike;
  const ok = reconcileWireWithWitness(wire, { message: w, renderedText: wireText });
  assert.equal(ok.agreement, 'full');
  const bad = reconcileWireWithWitness(wire, { message: w, renderedText: 'Different UI text' });
  assert.equal(bad.agreement, 'conflict');
  if (bad.agreement === 'conflict' && bad.kind === 'ui_text_differs') {
    assert.ok(bad.detail.uiDigest && bad.detail.wireDigest);
  }
  const order = reconcileWireWithWitness(
    { ...wire, order: ['p2', 'p1'] },
    { message: { v: 1, ui_ordering: ['p1', 'p2'] }, renderedText: wireText }
  );
  assert.equal(order.agreement, 'conflict');
});
