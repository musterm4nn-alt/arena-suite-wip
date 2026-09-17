import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, shapeHash, structuralSkeleton, sha256Hex, ArchiveError, ManualClock } from './index.ts';

test('canonicalJson sorts keys at all depths', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('shapeHash ignores values but respects types and keys', () => {
  assert.equal(shapeHash({ x: 'a', n: 1 }), shapeHash({ x: 'zzz', n: 99 }));
  assert.notEqual(shapeHash({ x: 'a', n: 1 }), shapeHash({ x: 'a', n: 'str' }));
  assert.notEqual(shapeHash({ x: 'a' }), shapeHash({ y: 'a' }));
});

test('shapeHash is stable across array length', () => {
  assert.equal(shapeHash({ l: [1, 2, 3] }), shapeHash({ l: [9] }));
});

test('skeleton collapses beyond maxDepth', () => {
  const deep = { a: { b: { c: { d: 'x' } } } };
  assert.deepEqual(structuralSkeleton(deep, 2), { a: { b: '{…}' } });
});

test('sha256Hex known vector', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('ArchiveError serializes safely without payload', () => {
  const e = new ArchiveError('E_CONFIRM_REQUIRED', 'directive missing', { directive: 'd1' });
  assert.deepEqual(e.toJSON(), { error: 'E_CONFIRM_REQUIRED', message: 'directive missing', details: { directive: 'd1' } });
});

test('ManualClock advances', () => {
  const c = new ManualClock(1000);
  c.advance(500);
  assert.equal(c.now(), 1500);
});
