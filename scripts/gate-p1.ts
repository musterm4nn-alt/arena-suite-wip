import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { sha256Hex } from '@arena/core';
import { GateRunner } from './gatekit.ts';
import { McpUdsServer, McpLineClient } from '@arena/archive-service';
import { TOOL_DEFINITIONS } from '@arena/mcp-contract';
import { createHeadlessStack } from '../apps/desktop/src/headless.ts';
import { sseBattleStream, type FixtureTurn } from '@arena/fixtures';

/**
 * P1 · Smallest vertical slice (plan §15):
 * one account, one complete stream, one crash-during-stream (partial_stream),
 * observation+normalized records, transcript query THROUGH MCP, provenance
 * lookup, scratch deletion with directive. Proves browser->sanitizer->storage->
 * transcript->MCP end to end over a real socket.
 */
const GATE = new GateRunner('p1', '1.0.0');
const turn: FixtureTurn = {
  prompt: 'Give me a haiku about persistence',
  answer: 'Old keyboard keys click —\neach keystroke an act of faith\nthat memory holds.',
  modelLabel: 'mystery-model-a',
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'arena-p1-'));
  const sockPath = join(root, 'mcp.sock');
  const stack = await createHeadlessStack({ root });
  const server = new McpUdsServer({
    socketPath: sockPath,
    tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    onCall: (name, args) => stack.service.dispatch(name, args),
  });
  await server.listen();
  let client: McpLineClient | null = null;
  let acct = '';
  try {
    client = new McpLineClient(sockPath);
    await client.ready();

    await GATE.check('p1.mcp_handshake', 'MCP initialize + tools/list over Unix socket', 'framing invalid or tool list empty', async () => {
      const init = await client!.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gate', version: '0' } });
      const list = await client!.request('tools/list');
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      return { server: (init.result as { serverInfo: { name: string } }).serverInfo.name, tools: tools.length, __fail: tools.length === 0 };
    });

    await GATE.check('p1.create_and_capture', 'Account + complete stream turn captured via MCP-visible store', 'turn not complete or parts empty', async () => {
      const created = await callTool(client!, 'accounts_create', { label: 'owner', storage_path: join(root, 'partition') });
      acct = (created as { account_id: string }).account_id;
      const sseBody = sseBattleStream(turn, { conv: 'conv-p1' });
      await stack.service.openCapture(acct);
      const pipeline = stack.service.pipelineFor(acct)!;
      const scripted = await stack.adapter.createAccountView({
        accountId: acct, storagePath: join(root, 'partition'), allowPopupsSamePartition: true,
        script: { streams: [{ requestId: 'p1r', url: 'https://arena.ai/api/generate', method: 'POST', body: sseBody, contentType: 'text/event-stream', transportTerminal: 'loadingFinished' }] },
      });
      await scripted.attach();
      await scripted.enableNetwork({ bufferSizeBytes: 1 << 20 });
      await scripted.enablePage(); await scripted.enableRuntime();
      await scripted.addIsolatedBinding('__ARENA_ARCHIVE__', 'arena-archive');
      await scripted.addScriptOnNewDocument('/*w*/', 'arena-archive');
      await scripted.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
      pipeline.attachAdapter(scripted, stack.store.activeEpoch(acct)!.id);
      await scripted.navigate('https://arena.ai/');
      pipeline.drainQueue();
      const convRow = stack.store.db.prepare('SELECT id FROM conversation WHERE external_ref=?').get('conv-p1') as { id: string } | undefined;
      if (!convRow) return { conv: null, __fail: true, reason: 'conversation not recorded' };
      const br = stack.store.listBranches(convRow.id).at(0)!;
      const t = stack.store.getBranchTurns(String(br.id)).at(0)!;
      return { conversation: convRow.id, completeness: t.completeness, __fail: t.completeness !== 'complete' };
    });

    let convId = '';
    await GATE.check('p1.transcript_via_mcp', 'archive_get_conversation + get_turn return exact transcript text', 'text from MCP differs from source body', async () => {
      convId = String((stack.store.db.prepare('SELECT id FROM conversation WHERE external_ref=?').get('conv-p1') as { id: string }).id);
      const conv = await callTool(client!, 'archive_get_conversation', { conversation_id: convId }) as {
        conversation: { mode: string }; branches: Array<{ turns: Array<{ id: string; completeness: string }> }> };
      const tid = conv.branches[0]!.turns[0]!.id;
      const got = await callTool(client!, 'archive_get_turn', { turn_id: tid }) as { parts: Array<{ content_json: string }> };
      const text = got.parts.map((p) => (JSON.parse(p.content_json) as { text?: string }).text ?? '').join('');
      return { text_matches: text === turn.answer, mode: conv.conversation.mode, __fail: text !== turn.answer };
    });

    await GATE.check('p1.provenance_lookup', 'Every turn part resolves to observation evidence with account stamp', 'provenance empty or account mismatch', async () => {
      const prov = await callTool(client!, 'archive_get_provenance', { entity_table: 'part', entity_id: String((stack.store.db.prepare('SELECT id FROM part LIMIT 1').get() as { id: string }).id) }) as Array<{ observation: { account_id: string; mechanism: string } }>;
      const ok = prov.length > 0 && prov.every((p) => p.observation && p.observation.account_id === acct);
      return { links: prov.length, mechanism: prov[0]?.observation?.mechanism, __fail: !ok };
    });

    await GATE.check('p1.secret_canary_never_persisted', 'Authorization canary absent from raw DB file bytes', 'canary found in stored payloads', async () => {
      const bytes = await readFile(join(root, 'archive.db'));
      const text = bytes.toString('latin1');
      const leaks = ['leak-canary-xyz', 'Bearer supersecret', 'eyJhbGci'].filter((c) => text.includes(c));
      const bundle = await callTool(client!, 'archive_export', { account_id: acct }) as { integrity_sha256: string };
      const bundleText = JSON.stringify(bundle);
      const bundleLeaks = ['leak-canary-xyz', 'Bearer supersecret'].filter((c) => bundleText.includes(c));
      return { db_leaks: leaks, bundle_leaks: bundleLeaks, db_bytes: bytes.length, __fail: leaks.length + bundleLeaks.length > 0 };
    });

    await GATE.check('p1.crash_partial_stream', 'Crash mid-stream persists partial_stream via MCP query', 'crashed turn missing or marked complete', async () => {
      const pipeline = stack.service.pipelineFor(acct)!;
      const scripted = await stack.adapter.createAccountView({
        accountId: acct, storagePath: join(root, 'partition'), allowPopupsSamePartition: true,
        script: {
          streams: [{ requestId: 'crash1', url: 'https://arena.ai/api/generate', method: 'POST', body: 'data: {"t":"delta","text":"half a thought about resilience, cut short"}\n\n', contentType: 'text/event-stream', transportTerminal: 'none' }],
          crashDuringStream: true,
        },
      });
      await scripted.attach();
      await scripted.enableNetwork({ bufferSizeBytes: 1 << 20 });
      await scripted.enablePage(); await scripted.enableRuntime();
      await scripted.setAutoAttach({ flatten: true, waitForDebuggerOnStart: true });
      pipeline.attachAdapter(scripted, stack.store.activeEpoch(acct)!.id);
      await scripted.navigate('https://arena.ai/');
      pipeline.drainQueue();
      const t = stack.store.db.prepare(`SELECT t.completeness FROM turn t JOIN part p ON p.turn_id=t.id WHERE p.content_json LIKE '%cut short%'`).get() as { completeness: string } | undefined;
      return { state: t?.completeness, __fail: t?.completeness !== 'partial_stream' };
    });

    await GATE.check('p1.scratch_delete_with_directive', 'Deletion requires trusted directive; tombstone written; replay refused', 'delete without directive, or replay accepted', async () => {
      const noDir = await client!.request('tools/call', { name: 'maintenance_delete_conversation', arguments: { conversation_id: convId, directive_id: 'not-real' } });
      const errText = JSON.parse((noDir.result as { content: Array<{ text: string }> }).content[0]!.text);
      if ((noDir.result as { isError: boolean }).isError !== true) return { reason: 'delete without valid directive succeeded', __fail: true };
      const minted = stack.service.mintDeleteDirective({ scope: 'conversation', ids: [convId] });
      const del = await callTool(client!, 'maintenance_delete_conversation', { conversation_id: convId, directive_id: minted.id });
      const replay = await client!.request('tools/call', { name: 'maintenance_delete_conversation', arguments: { conversation_id: convId, directive_id: minted.id } });
      const replayErr = JSON.parse((replay.result as { content: Array<{ text: string }> }).content[0]!.text);
      const tomb = stack.store.db.prepare('SELECT * FROM tombstone WHERE target_id=?').get(convId);
      const visible = await callTool(client!, 'archive_search', { account_id: acct, query: 'keystroke' }) as { rows: unknown[] };
      return {
        first_error: errText.error, replay_error: replayErr.error, tombstone: !!tomb,
        search_after_delete: (visible.rows ?? []).length,
        __fail: errText.error !== 'E_CONFIRM_REQUIRED' || replayErr.error !== 'E_CONFIRM_REQUIRED' || !tomb || (visible.rows ?? []).length > 0,
      };
    });

    await GATE.check('p1.restart_durability', 'Reopen DB: turns/observations intact (journal-first write)', 'data missing after reopen', async () => {
      const before = stack.store.db.prepare('SELECT COUNT(*) AS c FROM observation').get() as { c: number };
      stack.db.close();
      const { openNodeSqlite } = await import('@arena/schema');
      const db2 = openNodeSqlite(join(root, 'archive.db'));
      const after = db2.prepare('SELECT COUNT(*) AS c FROM observation').get() as { c: number };
      const turns = db2.prepare('SELECT COUNT(*) AS c FROM turn').get() as { c: number };
      db2.close();
      stack.db = db2;
      return { obs_before: before.c, obs_after: after.c, turns_after_reopen: turns.c, __fail: after.c < before.c || turns.c < 1 };
    });
  } finally {
    client?.close();
    await server.close();
    try { await rm(root, { recursive: true, force: true }); } catch { /* already closed */ }
  }

  const artifact = await GATE.write();
  console.log(JSON.stringify({ overall: artifact.overall, summary: artifact.summary }, null, 2));
  for (const c of artifact.checks) {
    const icon = c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : '⊘';
    console.log(`  ${icon} ${c.id} ${c.error ? `[${c.error}]` : ''} ${JSON.stringify(c.measured).slice(0, 160)}`);
  }
  process.exit(artifact.overall === 'fail' ? 1 : 0);
}

async function callTool(client: McpLineClient, name: string, args: unknown): Promise<unknown> {
  const res = await client.request('tools/call', { name, arguments: args });
  const r = res.result as { content: Array<{ text: string }>; isError: boolean };
  if (r.isError) throw new Error(r.content[0]!.text);
  return JSON.parse(r.content[0]!.text);
}

await main();
