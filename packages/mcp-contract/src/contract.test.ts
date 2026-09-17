import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, FORBIDDEN_TOOLS } from './tools.ts';
import { openNodeSqlite, migrate } from '@arena/schema';
import { ArchiveStore } from '@arena/archive-service';
import { ArchiveService } from '@arena/archive-service';
import { ProtocolCatalog } from '@arena/protocol-catalog';

function service() {
  const db = openNodeSqlite(':memory:');
  migrate(db);
  return new ArchiveService({
    store: new ArchiveStore(db), catalog: new ProtocolCatalog(),
    capabilities: { adapterKind: 'mock', dbBackend: 'node-sqlite', dbEncrypted: false, keychainBackedKey: false, ownerSessionVerified: false, notes: [] },
  });
}

test('GUI/MCP parity: every service command has exactly one tool and vice versa', () => {
  const svc = service();
  const commands = svc.commandNames().sort();
  const tools = TOOL_DEFINITIONS.map((t) => t.command).sort();
  assert.deepEqual(tools, commands, 'tool<->command parity (plan §12.2)');
  assert.equal(new Set(tools).size, tools.length, 'no duplicate tools');
});

test('no execution escape hatches exist on either surface', () => {
  const svc = service();
  const names = new Set([...TOOL_DEFINITIONS.map((t) => t.name), ...svc.commandNames()]);
  for (const forbidden of FORBIDDEN_TOOLS) {
    assert.equal(names.has(forbidden), false, `forbidden tool exposed: ${forbidden}`);
  }
});

test('destructive tools require directive_id in their schema', () => {
  for (const t of TOOL_DEFINITIONS.filter((x) => x.description.includes('DESTRUCTIVE'))) {
    const props = t.inputSchema.properties as Record<string, unknown>;
    assert.ok(props && 'directive_id' in props, `${t.name} missing directive_id`);
  }
});

test('unknown commands surface E_UNSUPPORTED, never throw raw', async () => {
  const svc = service();
  await assert.rejects(() => svc.dispatch('sql', { q: 'DROP' }), (e: { code?: string }) => e.code === 'E_UNSUPPORTED');
});
