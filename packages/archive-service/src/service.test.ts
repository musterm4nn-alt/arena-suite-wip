import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openNodeSqlite, migrate } from '@arena/schema';
import { ArchiveStore } from './store.ts';
import { ArchiveService } from './service.ts';
import { ProtocolCatalog } from '@arena/protocol-catalog';
import { MockBrowserAdapter } from '@arena/browser-adapter';
import { sseBattleStream, ndjsonDirectStream, type FixtureTurn } from '@arena/fixtures';

function freshService() {
  const db = openNodeSqlite(':memory:');
  migrate(db);
  const store = new ArchiveStore(db);
  const catalog = new ProtocolCatalog();
  const adapter = new MockBrowserAdapter();
  const svc = new ArchiveService({
    store, catalog, adapter,
    capabilities: { adapterKind: 'mock', dbBackend: 'node-sqlite', dbEncrypted: false, keychainBackedKey: false, ownerSessionVerified: false, notes: [] },
    queueCapacity: 64, maxStreamBytes: 1 << 20,
  });
  return { db, store, catalog, adapter, svc };
}

const turn: FixtureTurn = {
  prompt: 'why is the sky blue?',
  answer: 'Because Rayleigh scattering disperses short wavelengths more strongly than long ones.',
  reasoning: 'Consider the electromagnetic spectrum and atmospheric molecules.',
  modelLabel: 'Model-A',
};

test('P1 vertical slice: stream -> journal -> normalized turn -> query', async () => {
  const { store, svc } = freshService();
  const acct = store.createAccount('owner', '/tmp/p/a');
  const sseBody = sseBattleStream(turn);
  await svc.openCapture(acct);
  const pipeline = svc.pipelineFor(acct)!;
  assert.ok(pipeline, 'capture pipeline attached to the account view');
  // Drive scripted traffic through a fully-armed view (attach-before-navigate enforced).
  const scripted = await (svc.adapter as MockBrowserAdapter).createAccountView({
    accountId: acct, storagePath: '/tmp/p/a', allowPopupsSamePartition: true,
    script: { streams: [{ requestId: 'r1', url: 'https://arena.ai/api/generate', method: 'POST', body: sseBody, contentType: 'text/event-stream', transportTerminal: 'loadingFinished', chunkSize: 7 }] },
  });
  await scripted.attach();
  await scripted.enableNetwork({ bufferSizeBytes: 1 << 20 });
  await scripted.enablePage();
  await scripted.enableRuntime();
  await scripted.addIsolatedBinding('__ARENA_ARCHIVE__', 'arena-archive');
  await scripted.addScriptOnNewDocument('/*witness*/', 'arena-archive');
  await scripted.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
  const off = pipeline.attachAdapter(scripted, store.activeEpoch(acct)!.id);
  await scripted.navigate('https://arena.ai/');
  const drained = pipeline.drainQueue();
  assert.ok(drained >= 3, 'request/response_head/stream observations journalled');
  off();
  // a complete assistant turn exists with parts and provenance
  const conv = store.db.prepare('SELECT id FROM conversation WHERE account_id=?').get(acct) as { id: string } | undefined;
  assert.ok(conv, 'conversation recorded');
  const branches = store.listBranches(conv!.id);
  assert.equal(branches.length, 1);
  const turns = store.getBranchTurns(String(branches[0]!.id));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.completeness, 'complete');
  const t = store.getTurn(String(turns[0]!.id))!;
  const joined = t.parts.map((p) => JSON.parse(String(p.content_json)) as { text?: string }).map((c) => c.text ?? '').join('');
  assert.ok(joined.includes('Rayleigh'));
  assert.ok(joined.includes('atmospheric molecules'), 'reasoning part captured');
  const prov = store.provenanceFor('part', String(t.parts[0]!.id));
  assert.ok(prov.length >= 1, 'part provenance links to observations');
  const obs = store.getObservation(Number(prov[0]!.observation_id))!;
  assert.equal(obs.account_id, acct);
  assert.equal(obs.mechanism, 'cdp_network');
});

test('search finds text via FTS and cursor pages are opaque + stable', async () => {
  const { store } = freshService();
  const acct = store.createAccount('s', '/tmp/p/s');
  const convId = store.upsertConversation({ accountId: acct, source: 'live', observedAt: 1 });
  const br = store.ensureBranch(convId, 'initial');
  for (let i = 0; i < 5; i++) {
    const tid = store.insertTurn({ branchId: br, seq: i + 1, role: 'assistant', completeness: 'complete' });
    store.insertPart(tid, 0, 'text', { text: `quantum tunnelling experiment ${i}` }, []);
  }
  const p1 = store.search({ accountId: acct, query: 'quantum tunnelling', limit: 2 });
  assert.equal(p1.rows.length, 2);
  assert.ok(p1.next_cursor);
  const p2 = store.search({ accountId: acct, query: 'quantum tunnelling', cursor: p1.next_cursor, limit: 2 });
  assert.equal(p2.rows.length, 2);
  assert.notDeepEqual(p2.rows.map((r) => r.part_id), p1.rows.map((r) => r.part_id));
  const p3 = store.search({ accountId: acct, query: 'quantum tunnelling', cursor: p2.next_cursor, limit: 2 });
  assert.equal(p3.rows.length, 1);
  assert.equal(p3.next_cursor, null);
  assert.throws(() => store.search({ accountId: acct, query: 'quantum', cursor: 'not-base64!' }), /bad cursor/);
});

test('identity claims append; resolution is a view preferring reveal over selection', () => {
  const { store } = freshService();
  const acct = store.createAccount('i', '/tmp/p/i');
  const conv = store.upsertConversation({ accountId: acct, source: 'live', observedAt: 1 });
  const pid = store.ensureParticipant(conv, 0);
  store.addIdentityClaim({ participantId: pid, type: 'blind_label', value: 'Model A' });
  let p = store.db.prepare('SELECT * FROM participant WHERE id=?').get(pid) as { resolved_name: string; resolution: string };
  assert.equal(p.resolution, 'unresolved');
  store.addIdentityClaim({ participantId: pid, type: 'selected_label', value: 'mystery-7b' });
  p = store.db.prepare('SELECT * FROM participant WHERE id=?').get(pid) as never;
  assert.equal(p.resolution, 'selected');
  store.addIdentityClaim({ participantId: pid, type: 'post_vote_reveal', value: 'revealed-llm-v3' });
  p = store.db.prepare('SELECT * FROM participant WHERE id=?').get(pid) as never;
  assert.equal(p.resolved_name, 'revealed-llm-v3');
  assert.equal(p.resolution, 'revealed');
  // evidence intact: all four claims still append-only visible
  assert.equal(store.identityEvidence(pid).length, 3);
});

test('export/import roundtrip keeps imported cohort separate and integrity-checked', () => {
  const { store, svc } = freshService();
  const acct = store.createAccount('e', '/tmp/p/e');
  const conv = store.upsertConversation({ accountId: acct, externalRef: 'ext-9', source: 'live', observedAt: 1 });
  const br = store.ensureBranch(conv, 'initial');
  const tid = store.insertTurn({ branchId: br, seq: 1, role: 'assistant', completeness: 'complete' });
  store.insertPart(tid, 0, 'text', { text: 'exported body' }, []);
  const bundle = svc.exportBundle(acct);
  assert.equal(bundle.conversations.length, 1);
  const { store: store2 } = freshService();
  const acct2 = store2.createAccount('imp', '/tmp/p/imp');
  const svc2 = new ArchiveService({ store: store2, catalog: new ProtocolCatalog(), capabilities: { adapterKind: 'mock', dbBackend: 'node-sqlite', dbEncrypted: false, keychainBackedKey: false, ownerSessionVerified: false, notes: [] } });
  const res = svc2.importBundle(acct2, JSON.parse(JSON.stringify(bundle)));
  assert.equal(res.imported_conversations, 1);
  assert.equal(res.imported_turns, 1);
  const rows = store2.db.prepare('SELECT completeness FROM turn').all() as { completeness: string }[];
  assert.equal(rows[0]!.completeness, 'imported');
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.conversations[0].branches[0].turns[0].parts[0].content.text = 'tampered';
  assert.throws(() => svc2.importBundle(acct2, tampered), /integrity/);
});

test('lock blocks normal commands; unlock requires token; recover works locked', async () => {
  const { svc, store } = freshService();
  store.createAccount('l', '/tmp/p/l');
  const list1 = await svc.dispatch('accounts_list', {});
  assert.equal((list1 as unknown[]).length, 1);
  await svc.dispatch('maintenance_lock', { token: 'sekret-token-1' });
  await assert.rejects(() => svc.dispatch('accounts_list', {}), /locked/);
  const health = await svc.dispatch('diagnostics_recover', {});
  assert.equal((health as { integrity: string }).integrity, 'ok');
  await assert.rejects(() => svc.dispatch('maintenance_unlock', { token: 'wrong' }), /E_CONFIRM_REQUIRED|bad unlock/);
  await svc.dispatch('maintenance_unlock', { token: 'sekret-token-1' });
  const list2 = await svc.dispatch('accounts_list', {});
  assert.equal((list2 as unknown[]).length, 1);
});

test('destructive delete requires a valid directive and honors scope', async () => {
  const { svc, store } = freshService();
  const acct = store.createAccount('d', '/tmp/p/d');
  const conv = store.upsertConversation({ accountId: acct, source: 'live', observedAt: 1 });
  const br = store.ensureBranch(conv, 'initial');
  store.insertTurn({ branchId: br, seq: 1, role: 'assistant', completeness: 'complete' });
  // No directive -> MCP cannot delete.
  await assert.rejects(() => svc.dispatch('maintenance_delete_conversation', { conversation_id: conv, directive_id: 'nope' }), /E_CONFIRM_REQUIRED|unknown directive/);
  const m = svc.mintDeleteDirective({ scope: 'conversation', ids: [conv] });
  const r = await svc.dispatch('maintenance_delete_conversation', { conversation_id: conv, directive_id: m.id });
  assert.deepEqual(r, { removed_turns: 1, removed_parts: 0 });
  // replay now fails (single-use)
  await assert.rejects(() => svc.dispatch('maintenance_delete_conversation', { conversation_id: conv, directive_id: m.id }), /already used|E_CONFIRM_REQUIRED/);
  const tomb = store.db.prepare('SELECT * FROM tombstone WHERE target_id=?').get(conv) as { scope_hash: string };
  assert.ok(tomb.scope_hash.length === 64);
  const convRow = store.db.prepare('SELECT suppressed FROM conversation WHERE id=?').get(conv) as { suppressed: number };
  assert.equal(convRow.suppressed, 1);
});

test('account-scope directive cannot delete the wrong account', async () => {
  const { svc, store } = freshService();
  const a1 = store.createAccount('one', '/tmp/p/1');
  const a2 = store.createAccount('two', '/tmp/p/2');
  const c1 = store.upsertConversation({ accountId: a1, source: 'live', observedAt: 1 });
  const m = svc.mintDeleteDirective({ scope: 'account', ids: [a1] });
  await assert.rejects(() => svc.dispatch('maintenance_delete_account', { account_id: a2, directive_id: m.id }), /scope mismatch|E_CONFIRM_REQUIRED/);
  const ok = await svc.dispatch('maintenance_delete_account', { account_id: a1, directive_id: m.id });
  assert.deepEqual(ok, { tombstoned: true });
  void c1;
});
