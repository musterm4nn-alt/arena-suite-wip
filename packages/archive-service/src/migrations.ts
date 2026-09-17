/**
 * Numbered, transactional, forward-only migrations (plan §10.3).
 * v1: observations journal + accounts + protocol ops + checkpoints.
 * Preceded by a verified encrypted backup in production (service layer).
 */

export interface Migration {
  version: number;
  name: string;
  sql: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init-journal",
    sql: [
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS accounts (
         account_id TEXT PRIMARY KEY,
         display_hint TEXT,
         enabled INTEGER NOT NULL DEFAULT 1,
         created_at_ms INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS observations (
         id TEXT PRIMARY KEY,
         account_id TEXT NOT NULL,
         session_epoch_id TEXT,
         mechanism TEXT NOT NULL,
         target_id TEXT,
         cdp_session_id TEXT,
         operation_key TEXT NOT NULL,
         adapter_id TEXT,
         adapter_version TEXT,
         observed_at_ms INTEGER NOT NULL,
         completeness TEXT NOT NULL,
         evidence_ref TEXT,
         observer_gap INTEGER NOT NULL DEFAULT 0,
         payload_json TEXT,
         FOREIGN KEY (account_id) REFERENCES accounts(account_id)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_obs_account_time ON observations (account_id, observed_at_ms, id)`,
      `CREATE TABLE IF NOT EXISTS protocol_ops (
         id TEXT PRIMARY KEY,
         host_class TEXT NOT NULL,
         method TEXT NOT NULL,
         path_template TEXT NOT NULL,
         transport TEXT NOT NULL,
         direction TEXT NOT NULL,
         evidence_state TEXT NOT NULL,
         payload_family TEXT,
         shape_hash TEXT,
         adapter_id TEXT,
         adapter_version TEXT,
         completeness_model TEXT,
         first_seen_ms INTEGER NOT NULL,
         last_seen_ms INTEGER NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_key ON protocol_ops (method, path_template)`,
      `CREATE TABLE IF NOT EXISTS checkpoints (
         job_id TEXT PRIMARY KEY,
         account_id TEXT NOT NULL,
         cursor TEXT,
         page_fingerprint TEXT,
         seen_set_digest TEXT,
         items_committed INTEGER NOT NULL DEFAULT 0,
         adapter_id TEXT,
         adapter_version TEXT,
         run_sequence INTEGER NOT NULL DEFAULT 0,
         committed_at_ms INTEGER NOT NULL
       )`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
