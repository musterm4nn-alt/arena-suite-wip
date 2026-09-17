import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolCatalog, toPathTemplate, hostClass, inferTransport, inferDirection, operationKey, type ObservedRequest } from './index.ts';
import { shapeHash } from '@arena/core';

const req = (over: Partial<ObservedRequest> = {}): ObservedRequest => ({
  host: 'arena.ai', method: 'GET', url: 'https://arena.ai/api/conversations', ...over,
});

test('path templates mask identifiers structurally', () => {
  assert.equal(toPathTemplate('/api/conversations/550e8400-e29b-41d4-a716-446655440000/messages'), '/api/conversations/:id/messages');
  assert.equal(toPathTemplate('/api/items/12345'), '/api/items/:id');
  assert.equal(toPathTemplate('/api/items/abc123def456ghi789jkl0'), '/api/items/:id');
  assert.equal(toPathTemplate('/api/retry-later'), '/api/retry-later');
});

test('host classification buckets', () => {
  assert.equal(hostClass('arena.ai'), 'arena_first_party');
  assert.equal(hostClass('api.arena.ai'), 'arena_first_party');
  assert.equal(hostClass('cdn.assets.arena.dev'), 'arena_asset_cdn');
  assert.equal(hostClass('auth0.example.com'), 'auth_third_party');
  assert.equal(hostClass('random.io'), 'other');
});

test('transport inference: sse, rsc, websocket, download, unknown', () => {
  assert.equal(inferTransport(req(), { contentType: 'text/event-stream' }), 'sse');
  assert.equal(inferTransport(req(), { contentType: 'text/x-component' }), 'rsc');
  assert.equal(inferTransport(req({ resourceType: 'Document' }), { contentType: 'text/html; charset=utf-8' }), 'rsc');
  assert.equal(inferTransport(req(), { isWebSocket: true }), 'websocket');
  assert.equal(inferTransport(req(), { download: true }), 'download');
  assert.equal(inferTransport(req(), { contentType: 'application/json' }), 'json');
  assert.equal(inferTransport(req(), { contentType: 'weird/blob' }), 'unknown');
});

test('verb never yields replay authority: GET is only read-direction at seen-state', () => {
  const cat = new ProtocolCatalog();
  const op = cat.observe(req(), { contentType: 'application/json', status: 200 }, 100);
  assert.equal(op.direction, 'read');
  assert.equal(op.evidence_state, 'seen');
  assert.deepEqual(cat.replayQualified(), []);
});

test('evidence ladder: one step at a time; owner_verified_read demands probe+binding', () => {
  const cat = new ProtocolCatalog();
  const op = cat.observe(req(), { contentType: 'application/json', status: 200 }, 100);
  const key = ProtocolCatalog.opKey(op.host_class, op.method, op.path_template);
  assert.throws(() => cat.promote(key, 'owner_verified_read', { at: 1 }), /one step at a time/);
  cat.promote(key, 'classified', { at: 2 });
  assert.throws(() => cat.promote(key, 'owner_verified_read', { at: 3 }), /one step at a time/);
  cat.promote(key, 'adapter_ready', { adapterId: 'hist-list', at: 4 });
  assert.throws(() => cat.promote(key, 'owner_verified_read', { at: 5 }), /requires a completed read qualification probe/);
  assert.throws(() => cat.promote(key, 'owner_verified_read', { probeId: 'p1', at: 5 }), /account binding evidence/);
  cat.promote(key, 'owner_verified_read', { probeId: 'p1', accountBinding: 'epoch:e1', at: 6 });
  assert.equal(cat.replayQualified().length, 1);
});

test('mutate ops can never be owner_verified_read', () => {
  const cat = new ProtocolCatalog();
  const op = cat.observe(req({ method: 'POST', url: 'https://arena.ai/api/vote' }), { contentType: 'application/json', status: 200 }, 100);
  const key = ProtocolCatalog.opKey(op.host_class, op.method, op.path_template);
  assert.equal(op.direction, 'mutate');
  cat.promote(key, 'classified', { at: 1 });
  cat.promote(key, 'adapter_ready', { adapterId: 'a', at: 1 });
  assert.throws(() => cat.promote(key, 'owner_verified_read', { probeId: 'p', accountBinding: 'b', at: 1 }), /only read-direction/);
});

test('drift: shape change is recorded, counted, and invalidates qualification', () => {
  const cat = new ProtocolCatalog();
  const op = cat.observe(req(), { contentType: 'application/json', status: 200 }, 100);
  const key = ProtocolCatalog.opKey(op.host_class, op.method, op.path_template);
  cat.promote(key, 'classified', { at: 2 });
  cat.promote(key, 'adapter_ready', { adapterId: 'x', at: 3 });
  cat.promote(key, 'owner_verified_read', { probeId: 'p', accountBinding: 'b', at: 4 });
  const s1 = shapeHash({ items: [{ id: 'x', title: 't' }], cursor: 'c' });
  assert.equal(cat.observeShape(key, s1, [], 10), null);
  const s2 = shapeHash({ items: [{ id: 'x', title: 't', extra: 'E' }], cursor: 'c' });
  const drift = cat.observeShape(key, s2, [], 11);
  assert.equal(drift?.kind, 'shape_change');
  const ops = cat.operations.find((o) => o.id === op.id)!;
  assert.equal(ops.drift.shaped, 1);
  cat.invalidateByDrift(op.id);
  assert.deepEqual(cat.replayQualified(), []);
});

test('unknown fields produce drift, never guessing at schemas', () => {
  const cat = new ProtocolCatalog();
  const op = cat.observe(req({ url: 'https://arena.ai/api/stream/v2' }), { contentType: 'application/json' }, 1);
  const key = ProtocolCatalog.opKey(op.host_class, op.method, op.path_template);
  const s = shapeHash({ newfield: 1 });
  const drift = cat.observeShape(key, s, ['newfield'], 2);
  assert.equal(drift?.kind, 'unknown_fields');
});

test('same template from different ids collapses to one op; different verb is distinct', () => {
  const cat = new ProtocolCatalog();
  const a = cat.observe(req({ url: 'https://arena.ai/api/c/aaa1111111111111111bbb' }), {}, 1);
  const b = cat.observe(req({ url: 'https://arena.ai/api/c/bbb2222222222222222ccc' }), {}, 2);
  assert.equal(a.id, b.id);
  const merged = cat.operations.find((o) => o.id === a.id)!;
  assert.equal(merged.last_seen, 2); // observe() returns defensive copies; the store tracks the union
  const c = cat.observe(req({ method: 'POST', url: 'https://arena.ai/api/c/aaa1111111111111111bbb' }), {}, 3);
  assert.notEqual(c.id, a.id);
  assert.equal(inferDirection({ ...req(), method: 'POST' }), 'mutate');
});

test('operation key is stable hash', () => {
  assert.equal(operationKey('arena_first_party', 'GET', '/api/x'), operationKey('arena_first_party', 'GET', '/api/x'));
});
