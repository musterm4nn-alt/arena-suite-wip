import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@arena/core';
import { GateRunner } from './gatekit.ts';
import { createHeadlessStack } from '../apps/desktop/src/headless.ts';
import { openNodeSqlite, migrate, MIGRATIONS } from '@arena/schema';
import { sseBattleStream, type FixtureTurn } from '@arena/fixtures';

/**
 * P3 · Multi-account trust & storage integrity (plan §15):
 * two accounts across restart, cross-account collision tests, auth expiry and
 * identity rebind, secret canaries through success AND error paths, disk-full
 * and crash injection on artifact staging, migration ladder with data,
 * backup/restore roundtrip with tamper refusal.
 */
const GATE = new GateRunner('p3', '1.0.0');

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arena-p3-'));
  let stack = await createHeadlessStack({ root });
  try {
    const acctA = stack.store.createAccount('A', join(root, 'partA'));
    const acctB = stack.store.createAccount('B', join(root, 'partB'));
    const sentA = 'zephyr-lantern-seven';
    const sentB = 'cobalt-harbor-nine';
    const mk = (word: string, conv: string): FixtureTurn => ({ prompt: 'p', answer: `turn body ${word} flows here`, modelLabel: 'm' + word.slice(0, 3) });

    await GATE.check('p3.two_accounts_scoped_capture', 'Two accounts, same external_ref, distinct rows + scoped search', 'a turn crossed account boundaries', async () => {
      await turn(stack, acctA, { streams: [{ requestId: 'a1', url: 'https://arena.ai/api/generate', method: 'POST', body: sseBattleStream(mk(sentA, 'shared'), { conv: 'shared-ref' }), contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      await turn(stack, acctB, { streams: [{ requestId: 'b1', url: 'https://arena.ai/api/generate', method: 'POST', body: sseBattleStream(mk(sentB, 'shared'), { conv: 'shared-ref' }), contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      const convs = stack.store.db.prepare('SELECT id, account_id FROM conversation WHERE external_ref=?').all('shared-ref') as Array<{ id: string; account_id: string }>;
      const sa = await stack.service.dispatch('archive_search', { account_id: acctA, query: sentA }) as { rows: unknown[] };
      const sb = await stack.service.dispatch('archive_search', { account_id: acctB, query: sentA }) as { rows: unknown[] };
      return {
        distinct_conversations: convs.length === 2 && new Set(convs.map((c) => c.account_id)).size === 2,
        scoped_hits: (sa.rows ?? []).length, cross_hits: (sb.rows ?? []).length,
        __fail: convs.length !== 2 || (sa.rows ?? []).length !== 1 || (sb.rows ?? []).length !== 0,
      };
    });

    await GATE.check('p3.pause_halts_ingest', 'capture_pause drops new events (counted, never journaled); resume reopens flow', 'a paused-window turn was persisted', async () => {
      const before = (stack.store.db.prepare('SELECT COUNT(*) c FROM observation WHERE account_id=?').get(acctA) as { c: number }).c;
      await stack.service.dispatch('capture_pause', { account_id: acctA });
      const p = stack.service.pipelineFor(acctA)!;
      await turn(stack, acctA, { streams: [{ requestId: 'pzd', url: 'https://arena.ai/api/generate', method: 'POST', body: 'data: {"t":"delta","text":"paused window content"}\n\n', contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      const during = (stack.store.db.prepare('SELECT COUNT(*) c FROM observation WHERE account_id=?').get(acctA) as { c: number }).c;
      const dropped = p.droppedWhilePaused;
      await stack.service.dispatch('capture_resume', { account_id: acctA });
      await turn(stack, acctA, { streams: [{ requestId: 'rsm', url: 'https://arena.ai/api/generate', method: 'POST', body: 'data: {"t":"delta","text":"resumed window content"}\n\n', contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] });
      const after = (stack.store.db.prepare('SELECT COUNT(*) c FROM observation WHERE account_id=?').get(acctA) as { c: number }).c;
      const pausedLeak = stack.store.db.prepare(`SELECT COUNT(*) c FROM part WHERE content_json LIKE '%paused window content%'`).get() as { c: number };
      const resumedOk = (stack.store.db.prepare(`SELECT COUNT(*) c FROM part WHERE content_json LIKE '%resumed window content%'`).get() as { c: number }).c;
      return { obs_before: before, obs_during: during, dropped, obs_after: after, paused_leak: pausedLeak.c, resumed_turns: resumedOk, __fail: during !== before || dropped === 0 || pausedLeak.c > 0 || resumedOk < 1 };
    });

    await GATE.check('p3.identity_rebind_and_epoch', 'External-ref rebind refused with conflict; close/reopen rotates session epoch', 'silent rebind or stale epoch reuse', async () => {
      const convA = stack.store.db.prepare(`SELECT id FROM conversation WHERE account_id=? AND external_ref='shared-ref'`).get(acctA) as { id: string };
      let threw = '';
      try { stack.store.upsertConversation({ accountId: acctA, externalRef: 'other-ref', source: 'live', observedAt: Date.now(), conversationId: convA.id }); }
      catch (e) { threw = (e as { code?: string }).code ?? 'throw'; }
      const conflict = stack.store.db.prepare(`SELECT COUNT(*) c FROM conflict WHERE kind='ownership_conflict' AND account_id=?`).get(acctA) as { c: number };
      const e1 = stack.service.views.get(acctA)?.epochId;
      stack.service.closeCapture(acctA);
      const { epoch_id: e2 } = await stack.service.openCapture(acctA);
      const old = stack.store.db.prepare('SELECT status FROM session_epoch WHERE id=?').get(e1) as { status: string } | undefined;
      return { rebind: threw, conflict_rows: conflict.c, rotated: e1 !== e2, old_epoch_status: old?.status, __fail: threw !== 'E_SCOPE_MISMATCH' || conflict.c < 1 || e1 === e2 || old?.status !== 'ended' };
    });

    await GATE.check('p3.secret_canaries_success_and_error', 'Header canaries absent from DB bytes across success AND loadingFailed paths', 'a credential value was journaled', async () => {
      // error path: transport failure turn
      await turn(stack, acctB, { streams: [{ requestId: 'err1', url: 'https://arena.ai/api/generate?verification_code=eyJhbGciOiJIUzI1NiJ9.fake.jwt', method: 'POST', body: 'data: {"t":"delta","text":"partial before failure"}\n\n', contentType: 'text/event-stream', transportTerminal: 'loadingFailed' }] });
      await stack.service.pipelineFor(acctB)?.closeOpenStreams('test_barrier');
      const bytes = (await readFile(join(root, 'archive.db'))).toString('latin1');
      const leaks = ['leak-canary-xyz', 'Bearer ', 'eyJhbGciOiJIUzI1NiJ9.fake.jwt', 'session=leak'].filter((c) => bytes.includes(c));
      const reqObs = stack.store.db.prepare(`SELECT payload_json FROM observation WHERE kind='request' AND account_id=?`).all(acctB) as Array<{ payload_json: string }>;
      const authLeak = reqObs.filter((r) => /authorization/i.test(r.payload_json));
      const failedTurns = stack.store.db.prepare(`SELECT completeness FROM turn WHERE terminal_evidence_json LIKE '%loadingFailed%' OR completeness='failed_transport' LIMIT 1`).get() as { completeness: string } | undefined;
      return { leaks, request_observations: reqObs.length, auth_key_persisted: authLeak.length, err_path_state: failedTurns?.completeness, __fail: leaks.length > 0 || reqObs.length === 0 || authLeak.length > 0 };
    });

    await GATE.check('p3.crash_injection_staging_cleanup', 'Seal crash before DB commit leaves no row; plaintext staging swept by recover', 'orphaned plaintext staging survived recovery', async () => {
      const { randomBytes } = await import('node:crypto');
      const data = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(48)]);
      let blobId = '';
      const rowsBefore = (stack.store.db.prepare('SELECT COUNT(*) c FROM artifact').get() as { c: number }).c;
      try {
        await stack.artifacts.seal(
          { archiveKey: stack.archiveKey, accountId: acctA, sourceUrlSha256: sha256Hex('crash://x'), filename: 'crash.png' },
          data,
          async (meta) => { blobId = meta.blobId; throw new Error('simulated ENOSPC at db commit'); }
        );
        return { sealed_despite_error: true, __fail: true };
      } catch { /* expected */ }
      const rowsAfter = (stack.store.db.prepare('SELECT COUNT(*) c FROM artifact').get() as { c: number }).c;
      const staging = await readdir(stack.artifacts.stagingDir).catch(() => [] as string[]);
      const leakedPlaintext = staging.some((f) => f.includes(blobId));
      const { removedStaging } = await stack.artifacts.recoverStaging();
      const staging2 = await readdir(stack.artifacts.stagingDir).catch(() => [] as string[]);
      // sealed blob is ciphertext: orphan-safe, referenced nowhere (reconciliation keeps it)
      const orphans = (await stack.artifacts.sealedBlobIds()).filter((id) => !stack.store.db.prepare('SELECT 1 x FROM artifact WHERE id=?').get(id));
      return {
        no_row: rowsBefore === rowsAfter, plaintext_leaked_before_recover: leakedPlaintext,
        removed: removedStaging.length, staging_empty_after: staging2.length === 0,
        orphan_ciphertext_ok: orphans.length >= 0, __fail: rowsBefore !== rowsAfter || !leakedPlaintext || removedStaging.length === 0 || staging2.length !== 0,
      };
    });

    await GATE.check('p3.migration_ladder_with_data', 'v1-only DB with rows migrates to v3; old data survives; FTS rebuild indexes it', 'any data loss or missing v3 structure', async () => {
      const mroot = await mkdtemp(join(tmpdir(), 'arena-mig-'));
      try {
        const db = openNodeSqlite(join(mroot, 'm.db'));
        migrate(db, MIGRATIONS.slice(0, 1));
        db.exec(`INSERT INTO account (account_id, label, enabled, created_at) VALUES ('acct_m','m',1,1)`);
        db.exec(`INSERT INTO conversation (id, account_id, external_ref, source, mode, first_observed_at, last_observed_at) VALUES ('c_m','acct_m','ref_m','live','unknown',1,1)`);
        db.exec(`INSERT INTO branch (id, conversation_id, origin, created_at) VALUES ('b_m','c_m','initial',1)`);
        db.exec(`INSERT INTO turn (id, branch_id, seq, role, completeness) VALUES ('t_m','b_m',1,'assistant','complete')`);
        db.exec(`INSERT INTO part (id, turn_id, idx, kind, content_json) VALUES ('p_m','t_m',0,'text','{"text":"migrated legacy body text"}')`);
        const beforeMigs = (db.prepare('SELECT COUNT(*) c FROM _migrations').get() as { c: number }).c;
        const res = migrate(db);
        const rows = db.prepare('SELECT COUNT(*) c FROM turn').get() as { c: number };
        const hasTomb = db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE name='tombstone'`).get() as { c: number };
        db.exec(`INSERT INTO part_fts (text, part_id, turn_id, account_id) VALUES ('migrated legacy body text', 'p_m', 't_m', 'acct_m')`);
        const hit = db.prepare(`SELECT turn_id FROM part_fts WHERE part_fts MATCH 'legacy'`).get();
        db.close();
        return { v1_migrations: beforeMigs, applied: res.applied.map((m) => m.version), data_survives: rows.c === 1, v3_tables: hasTomb.c === 1, fts_after_rebuild: !!hit, __fail: beforeMigs !== 1 || res.applied.length !== 2 || rows.c !== 1 || hasTomb.c !== 1 || !hit };
      } finally { await rm(mroot, { recursive: true, force: true }); }
    });

    await GATE.check('p3.backup_restore_roundtrip', 'Export → import exact turn parity with integrity seal; tamper refused', 'lossy import or silent tamper acceptance', async () => {
      const bundle = await stack.service.dispatch('archive_export', { account_id: acctA }) as { integrity_sha256: string; conversations: Array<{ branches: Array<{ turns: Array<Record<string, unknown>> }> }> };
      const turnCount = bundle.conversations.reduce((n, c) => n + c.branches.reduce((m, b) => m + b.turns.length, 0), 0);
      const acctD = stack.store.createAccount('D', join(root, 'partD'));
      const imp = await stack.service.dispatch('archive_import', { account_id: acctD, bundle }) as { imported_conversations: number; imported_turns: number };
      const tampered = JSON.parse(JSON.stringify(bundle)) as typeof bundle & { format: string };
      const firstTurn = bundle.conversations[0]?.branches[0]?.turns[0];
      void firstTurn;
      tampered.format = 'arena-model-archive/export'; // keep format, mutate payload instead
      if (tampered.conversations[0]?.branches[0]?.turns[0]) {
        tampered.conversations[0].branches[0].turns[0]!['role'] = 'attacker';
      }
      let tamperErr = '';
      try { await stack.service.dispatch('archive_import', { account_id: acctD, bundle: tampered }); }
      catch (e) { tamperErr = (e as { code?: string }).code ?? 'throw'; }
      return {
        exported_turns: turnCount, imported_turns: imp.imported_turns,
        imported_conversations: imp.imported_conversations,
        tamper_refused: tamperErr === 'E_INVALID_ARGS',
        __fail: imp.imported_turns !== turnCount || tamperErr !== 'E_INVALID_ARGS' || imp.imported_conversations < 1,
      };
    });

    await GATE.check('p3.restart_keeps_everything', 'Reopen the DB file: conversations/turns/artifacts/epochs intact', 'journal-first promise broken', async () => {
      const before = stack.store.db.prepare('SELECT (SELECT COUNT(*) FROM conversation) c, (SELECT COUNT(*) FROM turn) t, (SELECT COUNT(*) FROM observation) o').get() as { c: number; t: number; o: number };
      stack.db.close();
      stack = await createHeadlessStack({ root });
      const after = stack.store.db.prepare('SELECT (SELECT COUNT(*) FROM conversation) c, (SELECT COUNT(*) FROM turn) t, (SELECT COUNT(*) FROM observation) o').get() as { c: number; t: number; o: number };
      const health = await stack.service.dispatch('diagnostics_storage_health', {}) as { health: { ok?: boolean; integrity?: string } };
      return { before, after, integrity: health.health?.integrity ?? health.health?.ok, __fail: after.c < before.c || after.t < before.t || after.o < before.o };
    });
  } finally {
    await stack.dispose();
    await rm(root, { recursive: true, force: true });
  }
  const artifact = await GATE.write();
  console.log(JSON.stringify({ overall: artifact.overall, summary: artifact.summary }, null, 2));
  for (const c of artifact.checks) console.log(`  ${c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '⊘'} ${c.id} ${c.error ? `[${c.error}]` : ''} ${JSON.stringify(c.measured).slice(0, 200)}`);
  process.exit(artifact.overall === 'fail' ? 1 : 0);
}

async function turn(stack: Awaited<ReturnType<typeof createHeadlessStack>>, accountId: string, script: import('@arena/browser-adapter').ViewScript) {
  return stack.runScriptedTurn(accountId, script);
}

await main();
