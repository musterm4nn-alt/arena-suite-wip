import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openNodeSqlite, migrate, integrityCheck, RoutedEventSchema, WitnessMessageSchema, MIGRATIONS } from './index.ts';

function freshDb() {
  const db = openNodeSqlite(':memory:');
  const res = migrate(db);
  return { db, res };
}

test('migrate applies all migrations on a fresh db', () => {
  const { db, res } = freshDb();
  assert.equal(res.from, 0);
  assert.equal(res.applied.length, 3);
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((t) => t.name);
  for (const t of ['account', 'observation', 'turn', 'part', 'protocol_op', 'sync_checkpoint', 'delete_directive', 'part_fts']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('migrate is idempotent', () => {
  const { db } = freshDb();
  const again = migrate(db);
  assert.deepEqual(again.applied, []);
  assert.equal(again.from, 3);
});

test('migrate accepts newly appended future migrations (forward only)', () => {
  const { db } = freshDb();
  const res = migrate(db, [
    ...MIGRATIONS,
    { version: 4, name: 'extra', up: (d) => d.exec('CREATE TABLE extra (x INTEGER)') },
  ]);
  assert.deepEqual(res.applied, [{ version: 4, name: 'extra' }]);
});

test('downgrade is refused', () => {
  const { db } = freshDb();
  db.prepare(`INSERT INTO _migrations (version, name, applied_at, sha256) VALUES (999,'future',0,'x')`).run();
  assert.throws(() => migrate(db), /refusing downgrade/);
});

test('integrity check passes', () => {
  const { db } = freshDb();
  assert.equal(integrityCheck(db).ok, true);
});

test('observation CHECK constraints enforce mechanism enum', () => {
  const { db } = freshDb();
  db.prepare(`INSERT INTO account (account_id, created_at) VALUES ('a1', 1)`).run();
  assert.throws(() =>
    db.prepare(`INSERT INTO observation (account_id, mechanism, observed_at, kind) VALUES ('a1','evil',1,'request')`).run()
  );
  db.prepare(`INSERT INTO observation (account_id, mechanism, observed_at, kind) VALUES ('a1','cdp_network',1,'request')`).run();
});

test('RoutedEventSchema rejects unknown keys and page-supplied authority fields', () => {
  const ok = RoutedEventSchema.parse({
    account_id: 'acct_1', mechanism: 'cdp_network', kind: 'chunk', observed_at: 1726570000000,
  });
  assert.equal(ok.completeness, 'unknown');
  assert.throws(() => RoutedEventSchema.parse({ account_id: 'a', kind: 'request', observed_at: -5 }));
  assert.throws(() =>
    RoutedEventSchema.parse({ account_id: 'a', mechanism: 'cdp_network', kind: 'request', observed_at: 1, evil: 1 })
  );
});

test('WitnessMessageSchema is UI-only and strict', () => {
  const w = WitnessMessageSchema.parse({
    v: 1, route: '/c/abc', participants: [{ position: 0, blind_label: 'Model A' }],
    vote: { selected_positions: [1], revealed: false },
  });
  assert.equal(w.route, '/c/abc');
  assert.throws(() => WitnessMessageSchema.parse({ v: 1, fetch: 'evil' }));
  assert.throws(() => WitnessMessageSchema.parse({ v: 2 }));
});
