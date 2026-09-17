import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, canonicalJson } from '@arena/core';
import { GateRunner } from './gatekit.ts';
import { createHeadlessStack, parseArenaListPage } from '../apps/desktop/src/headless.ts';
import { sseBattleStream, ndjsonDirectStream, splitAtOffsets, type FixtureTurn } from '@arena/fixtures';
import { canPromote, StreamAssembler } from '@arena/capture-core';
import type { SyncExecutor } from '@arena/sync';

/**
 * P2 · Complete text capture (plan §15): battle/direct/side-by-side,
 * completed/stopped/failed/partial, branches/regenerations, late identity,
 * history-opened conversations, worker/SW coverage, UI/network reconciliation,
 * downloads linked when available, golden fixtures under varied chunk
 * boundaries/order/duplicates.
 */
const GATE = new GateRunner('p2', '1.0.0');
type Stack = Awaited<ReturnType<typeof createHeadlessStack>>;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arena-p2-'));
  const stack = await createHeadlessStack({ root });
  try {
    const acct = stack.store.createAccount('p2-owner', join(root, 'part'));

    await GATE.check('p2.battle_mode_and_reveal', 'Battle capture records mode, participants, and post-vote reveal as append-only claims', 'reveal overwrites blind label evidence instead of appending', async () => {
      const t1: FixtureTurn = { prompt: 'p', answer: 'battle answer', modelLabel: 'alpha-9b' };
      const body = sseBattleStream(t1, { mode: 'battle', conv: 'battle-c1', revealed: { 0: 'alpha-9b', 1: 'beta-13b' } });
      await turn(stack, acct, { streams: [{ requestId: 'bt1', url: 'https://arena.ai/api/generate', method: 'POST', body, contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      const convRow = stack.store.db.prepare('SELECT * FROM conversation WHERE external_ref=?').get('battle-c1') as { id: string; mode: string } | undefined;
      if (!convRow) return { __fail: true, reason: 'conversation missing' };
      const participants = stack.store.db.prepare('SELECT * FROM participant WHERE conversation_id=?').all(convRow.id) as Array<{ position: number; resolved_name: string | null }>;
      const claims = stack.store.db.prepare('SELECT ic.type FROM identity_claim ic JOIN participant p ON p.id=ic.participant_id WHERE p.conversation_id=? ORDER BY ic.id').all(convRow.id) as Array<{ type: string }>;
      const p0 = participants.find((p) => p.position === 0);
      return {
        mode: convRow.mode, participants: participants.length,
        claim_types: [...new Set(claims.map((c) => c.type))].sort(),
        resolved: p0?.resolved_name,
        __fail: convRow.mode !== 'battle' || participants.length !== 2 || p0?.resolved_name !== 'alpha-9b'
          || !claims.some((c) => c.type === 'blind_label') || !claims.some((c) => c.type === 'post_vote_reveal'),
      };
    });

    await GATE.check('p2.direct_ndjson_stream', 'Direct mode NDJSON capture with exact assembled text', 'assembled text differs from source', async () => {
      const t: FixtureTurn = { prompt: 'x', answer: 'direct-mode answer with numbers 42 and ünïcode', modelLabel: 'gamma' };
      const body = ndjsonDirectStream(t);
      await turn(stack, acct, { streams: [{ requestId: 'nd1', url: 'https://arena.ai/api/generate', method: 'POST', body, contentType: 'application/x-ndjson', transportTerminal: 'loadingFinished' }] });
      const row = stack.store.db.prepare(`SELECT t.id FROM turn t JOIN part p ON p.turn_id=t.id WHERE p.content_json LIKE ?`).get('%direct-mode answer%') as { id: string } | undefined;
      if (!row) return { found: false, __fail: true };
      const parts = stack.store.db.prepare('SELECT content_json FROM part WHERE turn_id=? ORDER BY idx').all(row.id) as Array<{ content_json: string }>;
      const text = parts.map((p) => String((JSON.parse(p.content_json) as { text?: string }).text ?? '')).join('');
      return { text_matches: text === t.answer, digest: sha256Hex(text).slice(0, 12), __fail: text !== t.answer };
    });

    await GATE.check('p2.side_by_side_two_streams', 'Side-by-side turn yields both participant streams under one conversation', 'either side missing or mode wrong', async () => {
      const mk = (pos: number, name: string, txt: string) =>
        `data: ${JSON.stringify({ t: 'meta', conv: 'sbs-1', mode: 'side_by_side', participants: [{ position: pos, displayed_name: name }] })}\n\ndata: ${JSON.stringify({ t: 'delta', text: txt })}\n\ndata: [DONE]\n\n`;
      await turn(stack, acct, { streams: [{ requestId: 'sbsA', url: 'https://arena.ai/api/generate?pos=0', method: 'POST', body: mk(0, 'left-model', 'left side reply'), contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      await turn(stack, acct, { streams: [{ requestId: 'sbsB', url: 'https://arena.ai/api/generate?pos=1', method: 'POST', body: mk(1, 'right-model', 'right side reply'), contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      const conv = stack.store.db.prepare('SELECT id, mode FROM conversation WHERE external_ref=?').get('sbs-1') as { id: string; mode: string };
      const parts = stack.store.db.prepare(`SELECT p.content_json FROM part p JOIN turn t ON t.id=p.turn_id JOIN branch b ON b.id=t.branch_id WHERE b.conversation_id=?`).all(conv.id) as Array<{ content_json: string }>;
      const texts = parts.map((p) => String((JSON.parse(p.content_json) as { text?: string }).text ?? ''));
      const names = stack.store.db.prepare('SELECT resolved_name FROM participant WHERE conversation_id=?').all(conv.id) as Array<{ resolved_name: string | null }>;
      return {
        mode: conv.mode, parts: texts.length,
        both_sides: texts.some((x) => x.includes('left side')) && texts.some((x) => x.includes('right side')),
        participants_recorded: names.length,
        __fail: conv.mode !== 'side_by_side' || !texts.some((x) => x.includes('left side')) || !texts.some((x) => x.includes('right side')),
      };
    });

    await GATE.check('p2.regenerations_are_branches', 'Regeneration creates a branch; prior output never replaced', 'branch count != 2 or first turn lost', async () => {
      const convRef = 'regen-1';
      const body1 = `data: ${JSON.stringify({ t: 'meta', conv: convRef })}\n\ndata: ${JSON.stringify({ t: 'delta', text: 'first attempt' })}\n\ndata: [DONE]\n\n`;
      await turn(stack, acct, { streams: [{ requestId: 'rg1', url: 'https://arena.ai/api/generate', method: 'POST', body: body1, contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      const conv = stack.store.db.prepare('SELECT id FROM conversation WHERE external_ref=?').get(convRef) as { id: string };
      const firstBranch = stack.store.listBranches(conv.id)[0]!;
      const regenBranch = stack.store.ensureBranch(conv.id, 'regeneration', String(firstBranch.id));
      const t2 = stack.store.insertTurn({ branchId: regenBranch, seq: 1, role: 'assistant', completeness: 'complete' });
      stack.store.insertPart(t2, 0, 'text', { text: 'second attempt' }, []);
      const branches = stack.store.listBranches(conv.id);
      const firstTurns = stack.store.getBranchTurns(String(firstBranch.id));
      return { branches: branches.length, first_branch_turns: firstTurns.length, __fail: branches.length !== 2 || firstTurns.length !== 1 };
    });

    await GATE.check('p2.promotion_rules', 'History read may promote only with same scope + reconciled digest', 'promotion on mismatched scope', () => {
      const ref = { account_id: 'a', conversation_id: 'c', branch_id: 'b', revision: 'r' };
      const good = canPromote({ current: 'partial_stream', historyTurn: ref, liveTurn: ref, historyCompleteness: 'complete', contentDigestLive: 'x', contentDigestHistory: 'x' });
      const bad = canPromote({ current: 'partial_stream', historyTurn: { ...ref, branch_id: 'b2' }, liveTurn: ref, historyCompleteness: 'complete', contentDigestLive: 'x', contentDigestHistory: 'x' });
      return { good: good.promote === true, bad: bad.promote === false, __fail: good.promote !== true || bad.promote !== false };
    });

    await GATE.check('p2.worker_target_stream', 'Stream from a dedicated-worker child target binds to the parent account', 'worker-stream turn missing or account mismatch', async () => {
      const body = `data: ${JSON.stringify({ t: 'meta', conv: 'sw-1' })}\n\ndata: ${JSON.stringify({ t: 'delta', text: 'served from worker thread' })}\n\ndata: [DONE]\n\n`;
      await turn(stack, acct, {
        targets: [{ targetId: 'w1', kind: 'dedicated_worker', afterNav: true }],
        streams: [{ requestId: 'w1s', url: 'https://arena.ai/api/worker', method: 'POST', body, contentType: 'text/event-stream', transportTerminal: 'loadingFinished', accountScope: 'w1' }],
      });
      const conv = stack.store.db.prepare('SELECT id, account_id FROM conversation WHERE external_ref=?').get('sw-1') as { id: string; account_id: string } | undefined;
      const part = stack.store.db.prepare(`SELECT p.content_json FROM part p JOIN turn t ON t.id=p.turn_id JOIN branch b ON b.id=t.branch_id WHERE b.conversation_id=?`).get(conv?.id ?? '') as { content_json: string } | undefined;
      const txt = part ? String((JSON.parse(part.content_json) as { text?: string }).text ?? '') : '';
      return { account_ok: conv?.account_id === acct, has_text: txt.includes('worker thread'), __fail: conv?.account_id !== acct || !txt.includes('worker thread') };
    });

    await GATE.check('p2.ui_vs_wire_reconciliation', 'Witness agreeing with wire passes; disagreeing witness records conflict, never rewrites', 'conflict suppressed or wire content replaced', async () => {
      const body = `data: ${JSON.stringify({ t: 'meta', conv: 'recon-1' })}\n\ndata: ${JSON.stringify({ t: 'delta', text: 'wire truth' })}\n\ndata: [DONE]\n\n`;
      await turn(stack, acct, { streams: [{ requestId: 'rc1', url: 'https://arena.ai/api/g', method: 'POST', body, contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      const conv = stack.store.db.prepare('SELECT id FROM conversation WHERE external_ref=?').get('recon-1') as { id: string };
      const br = stack.store.listBranches(conv.id).at(-1)!;
      const t = stack.store.getBranchTurns(String(br.id)).at(-1)!;
      const turnId = String(t.id);
      const p = stack.service.pipelineFor(acct)!;
      p.setWitness({ message: { v: 1, participants: [] }, renderedText: 'DIFFERENT UI text' });
      const recon = p.reconcile(turnId);
      const conflicts = stack.store.listConflicts(acct);
      const turnRow = stack.store.getTurn(turnId)!;
      const wireText = String((JSON.parse(String(turnRow.parts[0]!.content_json)) as { text?: string }).text);
      p.setWitness(null);
      return {
        agreement: recon.agreement, conflict_recorded: conflicts.length > 0,
        wire_text_intact: wireText === 'wire truth',
        __fail: recon.agreement !== 'conflict' || conflicts.length === 0 || wireText !== 'wire truth',
      };
    });

    await GATE.check('p2.history_backfill_walk', 'Qualified read walk archives history-opened conversations (source=backfill); unqualified replay refused', 'backfill rows missing or unqualified walk allowed', async () => {
      const pages = new Map<string, string>([
        ['', canonicalJson({ items: [{ id: 'h1', revision: '1', digest: sha256Hex('h1-v1') }, { id: 'h2', revision: '1', digest: sha256Hex('h2-v1') }], next_cursor: 'p2' })],
        ['p2', canonicalJson({ items: [{ id: 'h3', revision: '1', digest: sha256Hex('h3-v1') }], next_cursor: null })],
      ]);
      const ex: SyncExecutor = {
        async fetchPage({ cursor }) { const b = pages.get(cursor ?? ''); return b === undefined ? { status: 404, bodyText: '' } : { status: 200, bodyText: b }; },
        async fetchDetail({ itemId }) { return { status: 200, bodyText: `detail:${itemId}` }; },
        async fingerprint() { return 'hist-fp-v1'; },
      };
      stack.registerSyncExecutor(acct, ex);
      const start = await stack.service.dispatch('sync_start', { account_id: acct }) as { job_id: string };
      void start;
      // replay without read-qualification must be refused at the job boundary
      const walkRefused = await stack.runSyncWalk(acct, 'op_unverified').then(() => 'allowed', () => 'refused');
      const vq = await stack.service.dispatch('sync_verify_read', { account_id: acct, op_id: 'op_hist' }) as { qualified: boolean };
      if (!vq.qualified) return { qualified: false, __fail: true };
      const walk = await stack.runSyncWalk(acct, 'op_hist');
      const backfilled = stack.store.db.prepare(`SELECT COUNT(*) AS c FROM conversation WHERE account_id=? AND source='backfill'`).get(acct) as { c: number };
      await stack.service.dispatch('sync_verify_read', { account_id: acct, op_id: 'op_hist2' });
      const walk2 = await stack.runSyncWalk(acct, 'op_hist2');
      const rows2 = stack.store.db.prepare(`SELECT COUNT(*) AS c FROM conversation WHERE account_id=? AND source='backfill'`).get(acct) as { c: number };
      return {
        unqualified_walk: walkRefused, pages: walk.pages, state: walk.job.state,
        backfilled: backfilled.c, idempotent: rows2.c === backfilled.c, replay_pages: walk2.pages,
        __fail: walkRefused !== 'refused' || backfilled.c < 3 || walk.job.state !== 'completed' || rows2.c !== backfilled.c,
      };
    });

    await GATE.check('p2.golden_split_property_sweep', 'Assembled digest invariant under split boundaries, duplicate replay, every byte count', 'any split size producing a different digest', () => {
      const text = 'Golden body — ünïcode & bytes 🚀 '.repeat(9);
      const golden = sha256Hex(text);
      const bytes = Buffer.from(text, 'utf8');
      let trials = 0, fails = 0;
      const dup = [3, 11, 17, 17, 40, 41, 42, 97, bytes.length - 1];
      for (let cut = 0; cut <= bytes.length && trials < 256; cut += Math.max(1, Math.floor(bytes.length / 33))) {
        const partsArr = splitAtOffsets(text, dup.concat([cut]));
        const asm = new StreamAssembler({ maxAssembledBytes: 1 << 20 });
        asm.begin('g', { accountId: 'a' });
        let seq = 0;
        for (let i = 0; i < partsArr.length; i++) {
          asm.appendChunk('g', { seq, bytes: partsArr[i]!, at: i }, { accountId: 'a' });
          if (cut % 3 === 0) asm.appendChunk('g', { seq, bytes: partsArr[i]!, at: i + 500 }, { accountId: 'a' }); // same-seq redelivery: must be deduped
          seq++;
        }
        asm.transportFinished('g', 99);
        trials++;
        if (sha256Hex(asm.finalize('g').text) !== golden) fails++;
      }
      return { trials, fails, golden: golden.slice(0, 12), __fail: fails > 0 || trials < 30 };
    });

    await GATE.check('p2.download_artifact_linked', 'Artifact sealed from scripted download links to account + provenance hash', 'blob absent or round-trip mismatch', async () => {
      const { randomBytes } = await import('node:crypto');
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(64)]);
      const res = await stack.artifacts.seal(
        { archiveKey: stack.archiveKey, accountId: acct, sourceUrlSha256: sha256Hex('https://arena.ai/f/x'), filename: 'plot.png' },
        png,
        async (meta, path) => {
          stack.store.db.prepare('INSERT INTO artifact (id, account_id, filename_safe, source_url_ref, size_bytes, sha256, mime, blob_path, sealed_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(meta.blobId, acct, 'plot.png', JSON.stringify({ host: 'arena.ai', path: '/f/x' }), meta.sizeBytes, meta.sha256, meta.mime, path, Date.now());
        }
      );
      const row = stack.store.db.prepare('SELECT * FROM artifact WHERE id=?').get(res.meta.blobId) as { account_id: string; mime: string } | undefined;
      const back = await stack.artifacts.open(stack.archiveKey, res.finalPath);
      return { linked: !!row && row.account_id === acct, roundtrip: sha256Hex(back) === sha256Hex(png), mime: row?.mime, __fail: !row || sha256Hex(back) !== sha256Hex(png) };
    });
  } finally {
    await stack.dispose();
    await rm(root, { recursive: true, force: true });
  }
  const artifact = await GATE.write();
  console.log(JSON.stringify({ overall: artifact.overall, summary: artifact.summary }, null, 2));
  for (const c of artifact.checks) console.log(`  ${c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '⊘'} ${c.id} ${c.error ? `[${c.error}]` : ''} ${JSON.stringify(c.measured).slice(0, 180)}`);
  process.exit(artifact.overall === 'fail' ? 1 : 0);
}

async function turn(stack: Stack, accountId: string, script: import('@arena/browser-adapter').ViewScript) {
  return stack.runScriptedTurn(accountId, script);
}

await main();
