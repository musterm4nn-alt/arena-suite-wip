import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHeaders, sanitizeJsonValue, toSafeUrlRef, scanForSecrets, DirectiveBroker } from './index.ts';
import { ManualClock, ArchiveError } from '@arena/core';

function d2expiresAt(clock: ManualClock): number { return clock.now() + 500 + 1; }

test('headers: auth/cookie dropped, allowlist kept', () => {
  const r = sanitizeHeaders({
    Authorization: 'Bearer supersecrettoken123456',
    Cookie: 'session=abc',
    'content-type': 'application/json',
    'x-amz-security-token': 'tok',
  });
  assert.deepEqual(r.kept, { 'content-type': 'application/json' });
  assert.ok(r.droppedNames.includes('authorization') && r.droppedNames.includes('cookie'));
  assert.equal(scanForSecrets(JSON.stringify(r)).length, 0);
});

test('json values: secret keys dropped, JWT string dropped, structure kept', () => {
  const p = sanitizeJsonValue({
    prompt: 'hello',
    password: 'hunter2',
    nested: { access_token: 'x', api_key: 'y', items: [{ text: 'ok' }] },
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF_ghiJKL-mno',
  });
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const s = JSON.stringify(p.value);
  assert.ok(s.includes('hello'));
  assert.ok(s.includes('"droppedSecret"'));
  assert.equal(scanForSecrets(s).length, 0);
});

test('fail-closed: huge payloads project to code+bytes+shapeHash only', () => {
  const big = { text: 'a'.repeat(3 * 1024 * 1024) };
  const p = sanitizeJsonValue(big);
  assert.equal(p.ok, false);
  if (p.ok) return;
  assert.equal(p.errorCode, 'PAYLOAD_TOO_LARGE');
  assert.ok(p.shapeHash.length === 64);
  assert.ok('byteLength' in p);
});

test('fail-closed: excessive depth', () => {
  let deep: Record<string, unknown> = { end: 1 };
  for (let i = 0; i < 40; i++) deep = { d: deep };
  const p = sanitizeJsonValue(deep);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.errorCode, 'PAYLOAD_TOO_DEEP');
});

test('safe url ref keeps correlation, kills replay', () => {
  const ref = toSafeUrlRef('https://cdn.arena.ai/f/123/abc?token=SECRET&expires=99&sig=xyz');
  assert.equal(ref.host, 'cdn.arena.ai');
  assert.equal(ref.path, '/f/123/abc');
  assert.deepEqual(ref.queryKeySet, ['expires', 'sig', 'token']);
  assert.equal(ref.expiryClass, 'known_expiry');
  const s = JSON.stringify(ref);
  assert.ok(!s.includes('SECRET') && !s.includes('xyz'));
});

test('directive broker: mint, verify, expiry, single-use, scope mismatch', () => {
  const clock = new ManualClock(1000);
  const b = new DirectiveBroker({ clock, ttlMs: 500 });
  const m = b.mint({ scope: 'conversation', ids: ['c2', 'c1', 'c1'] });
  const d = b.consume(m.id, { scope: 'conversation', ids: ['c1', 'c2'] }); // order-insensitive canonical match
  assert.equal(d.itemCount, 2);
  assert.throws(() => b.consume(m.id, { scope: 'conversation', ids: ['c1', 'c2'] }), (e: unknown) => (e as ArchiveError).code === 'E_CONFIRM_REQUIRED');

  const m2 = b.mint({ scope: 'account', ids: ['a1'] });
  assert.throws(() => b.consume(m2.id, { scope: 'account', ids: ['a1', 'a2'] }), (e: unknown) => (e as ArchiveError).code === 'E_CONFIRM_REQUIRED');

  const m3 = b.mint({ scope: 'archive', ids: [] });
  clock.set(d2expiresAt(clock));
  assert.throws(() => b.consume(m3.id, { scope: 'archive', ids: [] }), (e: unknown) => (e as ArchiveError).code === 'E_CONFIRM_REQUIRED');

  const m4 = b.mint({ scope: 'account', ids: ['a1'] });
  assert.throws(() => b.consume('forged-id', { scope: 'account', ids: ['a1'] }), (e: unknown) => (e as ArchiveError).code === 'E_CONFIRM_REQUIRED');
  void m4;
});

test('audit fields never include the nonce, keep scope hash for verification', () => {
  const b = new DirectiveBroker();
  const m = b.mint({ scope: 'conversation', ids: ['c1', 'c2'] });
  const d = b.consume(m.id, { scope: 'conversation', ids: ['c2', 'c1'] });
  const audit = DirectiveBroker.auditFields(d);
  assert.equal(audit.item_count, 2);
  assert.equal(audit.scope_hash.length, 64);
  assert.ok(!JSON.stringify(audit).includes(JSON.stringify(m))); // no raw nonce
});
