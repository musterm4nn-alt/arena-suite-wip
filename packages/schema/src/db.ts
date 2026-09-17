/**
 * Thin synchronous DB driver interface.
 *
 * The macOS product binds this to SQLCipher (encrypted SQLite + FTS5).
 * This sandbox binds Node's built-in `node:sqlite` (plaintext at rest — see
 * docs/platform.md; that difference is explicit in the evidence register,
 * never silently glossed over). Query text and schema are identical for both.
 */
export interface Row { [k: string]: unknown }
export interface Stmt {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}
export interface DbHandle {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Which backend this handle actually is — recorded in gate artifacts. */
  readonly backend: 'sqlcipher' | 'node-sqlite';
  readonly encrypted: boolean;
}

export function openNodeSqlite(path: string): DbHandle {
  // Lazy import keeps non-Node environments from breaking module load.
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=FULL'); // conservative durability per plan §10.3; measure before tuning
  db.exec('PRAGMA foreign_keys=ON');
  return wrap(db);

  function wrap(handle: InstanceType<typeof DatabaseSync>): DbHandle {
    return {
      backend: 'node-sqlite',
      encrypted: false,
      prepare(sql: string): Stmt {
        const s = handle.prepare(sql);
        const fix = (p: unknown[]): never[] => p.map(normalizeParam) as never[];
        return {
          run: (...p) => s.run(...fix(p)),
          get: (...p) => s.get(...fix(p)) as Row | undefined,
          all: (...p) => s.all(...fix(p)) as Row[],
        };
      },
      exec: (sql) => handle.exec(sql),
      transaction: <T>(fn: () => T): T => {
        handle.exec('BEGIN IMMEDIATE');
        try {
          const r = fn();
          handle.exec('COMMIT');
          return r;
        } catch (e) {
          handle.exec('ROLLBACK');
          throw e;
        }
      },
      close: () => handle.close(),
    };
  }
}

function normalizeParam(p: unknown): unknown {
  if (typeof p === 'boolean') return p ? 1 : 0;
  if (p === undefined) return null;
  if (p instanceof Uint8Array) return Buffer.from(p);
  return p;
}

// node:sqlite is CJS; provide a require for ESM files.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
