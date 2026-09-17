import type { DbHandle } from './db.ts';
import { MIGRATIONS, type Migration } from './migrations.ts';
import { canonicalJson, sha256Hex } from '@arena/core';

const MIG_TABLE = '_migrations';

export function ensureMigrationsTable(db: DbHandle): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIG_TABLE} (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, sha256 TEXT NOT NULL
     ) WITHOUT ROWID`
  );
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: { version: number; name: string }[];
}

/** Forward-only, transactional, one txn per migration (§10.3). */
export function migrate(db: DbHandle, migrations: Migration[] = MIGRATIONS, now: number = Date.now()): MigrateResult {
  ensureMigrationsTable(db);
  const rows = db.prepare(`SELECT version FROM ${MIG_TABLE}`).all() as { version: number }[];
  const appliedVersions = new Set(rows.map((r) => Number(r.version)));
  const from = Math.max(0, ...appliedVersions);
  const maxKnown = Math.max(0, ...migrations.map((m) => m.version));
  for (const v of appliedVersions) {
    if (v > maxKnown) {
      throw new Error(`Database has migration ${v} newer than known migrations (max ${maxKnown}); refusing downgrade`);
    }
  }
  const applied: { version: number; name: string }[] = [];
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (appliedVersions.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare(`INSERT INTO ${MIG_TABLE} (version, name, applied_at, sha256) VALUES (?,?,?,?)`).run(
        m.version,
        m.name,
        now,
        sha256Hex(canonicalJson(m.up.toString()))
      );
    });
    applied.push({ version: m.version, name: m.name });
  }
  return { from, to: maxKnown, applied };
}

export function integrityCheck(db: DbHandle): { ok: boolean; detail: string } {
  const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
  const detail = String(r?.integrity_check ?? 'no result');
  return { ok: detail === 'ok', detail };
}
