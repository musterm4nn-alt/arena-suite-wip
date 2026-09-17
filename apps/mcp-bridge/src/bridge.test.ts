import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpUdsServer } from '@arena/archive-service';
import { attachBridge, parseArgs } from './bridge.ts';
import { PassThrough } from 'node:stream';

test('parseArgs requires --socket', () => {
  assert.throws(() => parseArgs([]), /usage/);
  assert.deepEqual(parseArgs(['--socket', '/tmp/x.sock']).socketPath, '/tmp/x.sock');
});

test('stdio relay splices frames to a live UDS MCP server', async () => {
  const sockPath = join(tmpdir(), `arena-bridge-test-${process.pid}-${Date.now()}.sock`);
  const server = new McpUdsServer({
    socketPath: sockPath,
    tools: [{ name: 'ping_tool', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    onCall: async (name, args) => ({ echo: { name, args } }),
  });
  await server.listen();
  const { createConnection } = await import('node:net');
  const client = createConnection(sockPath);
  await new Promise<void>((r) => client.once('connect', r));
  const up = new PassThrough();
  const down = new PassThrough();
  attachBridge(client, up, down);
  let out = '';
  down.on('data', (d) => { out += d.toString(); });
  up.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping_tool', arguments: { a: 1 } } }) + '\n');
  for (let i = 0; i < 100 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 20));
  const msg = JSON.parse(out.trim()) as { result: { content: Array<{ text: string }> } };
  assert.deepEqual(JSON.parse(msg.result.content[0]!.text), { echo: { name: 'ping_tool', args: { a: 1 } } });
  client.destroy();
  await server.close();
});
