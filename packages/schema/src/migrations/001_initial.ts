/**
 * Initial migration — SQLCipher compatible SQLite schema.
 * Forward-only, transactional.
 * Every table includes account_id where relevant per non-negotiable rule #2.
 */

export const id = '001_initial';
export const description = 'Initial schema: accounts, session_epochs, observations, conversations, branches, turns, parts, identity_claims, artifacts, protocol_ops, sync_jobs, directives, analysis_runs';

export const sql = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Accounts: immutable local UUID, app-controlled partition path
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  email_hint TEXT,
  partition_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_state TEXT NOT NULL DEFAULT 'unknown',
  session_epoch_id TEXT,
  FOREIGN KEY(session_epoch_id) REFERENCES session_epochs(id)
);

CREATE TABLE IF NOT EXISTS session_epochs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_epochs_account ON session_epochs(account_id);

-- Observations: append-only, first durable write
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  session_epoch_id TEXT,
  mechanism TEXT NOT NULL,
  target_id TEXT,
  session_id TEXT,
  operation_key TEXT,
  observed_at TEXT NOT NULL,
  completeness_state TEXT NOT NULL,
  sanitized_evidence_ref TEXT,
  adapter_id TEXT,
  adapter_version TEXT,
  byte_length INTEGER,
  shape_hash TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(session_epoch_id) REFERENCES session_epochs(id)
);
CREATE INDEX IF NOT EXISTS idx_observations_account ON observations(account_id);
CREATE INDEX IF NOT EXISTS idx_observations_time ON observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_observations_op ON observations(operation_key);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  arena_conversation_id TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_account ON conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_conversations_arena_id ON conversations(arena_conversation_id);

CREATE TABLE IF NOT EXISTS conversation_observations (
  conversation_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  PRIMARY KEY(conversation_id, observation_id),
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
);

-- Branches
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_branch_id TEXT,
  revision_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_branch_id) REFERENCES branches(id)
);
CREATE INDEX IF NOT EXISTS idx_branches_conversation ON branches(conversation_id);

-- Turns
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  role TEXT NOT NULL,
  position INTEGER NOT NULL,
  completeness TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model_identity_claim_id TEXT,
  FOREIGN KEY(branch_id) REFERENCES branches(id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_turns_branch ON turns(branch_id);
CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_account ON turns(account_id);

-- Parts
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  artifact_id TEXT,
  tool_name TEXT,
  provenance_observation_id TEXT,
  FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE CASCADE,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id),
  FOREIGN KEY(provenance_observation_id) REFERENCES observations(id)
);
CREATE INDEX IF NOT EXISTS idx_parts_turn ON parts(turn_id);
CREATE INDEX IF NOT EXISTS idx_parts_fts ON parts(text) WHERE text IS NOT NULL;

-- Identity claims: append-only, never mutated
CREATE TABLE IF NOT EXISTS identity_claims (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT,
  branch_id TEXT,
  turn_id TEXT,
  turn_range_start INTEGER,
  turn_range_end INTEGER,
  claim_type TEXT NOT NULL,
  value TEXT NOT NULL,
  evidence_mechanism TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_identity_claims_account ON identity_claims(account_id);
CREATE INDEX IF NOT EXISTS idx_identity_claims_conversation ON identity_claims(conversation_id);

-- Artifacts: encrypted blobs, staged then sealed
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  conversation_id TEXT,
  turn_id TEXT,
  source_url_safe_ref TEXT,
  filename TEXT,
  mime_type TEXT,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  sealed_blob_path TEXT NOT NULL,
  staging_cleanup_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  derived_from_artifact_id TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
  FOREIGN KEY(turn_id) REFERENCES turns(id) ON DELETE SET NULL,
  FOREIGN KEY(derived_from_artifact_id) REFERENCES artifacts(id)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_account ON artifacts(account_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_sha ON artifacts(sha256);

-- Protocol catalog
CREATE TABLE IF NOT EXISTS protocol_ops (
  id TEXT PRIMARY KEY,
  host_class TEXT NOT NULL,
  method TEXT NOT NULL,
  path_template TEXT NOT NULL,
  transport TEXT NOT NULL,
  direction TEXT NOT NULL,
  evidence_state TEXT NOT NULL,
  account_binding_evidence TEXT NOT NULL,
  payload_family TEXT,
  shape_hash TEXT,
  adapter_id TEXT,
  adapter_version TEXT,
  completeness_model TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  drift_counters TEXT NOT NULL -- JSON
);

-- Sync jobs + checkpoints
CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL,
  listing_method TEXT NOT NULL,
  checkpoint TEXT, -- JSON
  blocking_reason TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_account ON sync_jobs(account_id);

-- Directives: single-use, short-lived, exact-scope
CREATE TABLE IF NOT EXISTS directives (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  account_id TEXT,
  conversation_ids TEXT NOT NULL, -- JSON array
  count INTEGER NOT NULL,
  canonical_scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_directives_expires ON directives(expires_at);

-- Analysis runs
CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  corpus_hash TEXT NOT NULL,
  adapter_versions TEXT NOT NULL, -- JSON
  code_version TEXT NOT NULL,
  config TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL,
  cohort_definition TEXT NOT NULL -- JSON
);

-- FTS5 for transcript search (separate from encrypted content, but built from sanitized text)
CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
  text,
  content='parts',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS parts_fts_insert AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS parts_fts_delete AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS parts_fts_update AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO parts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Delete tombstones / suppression markers
CREATE TABLE IF NOT EXISTS delete_tombstones (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  account_id TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  directive_id TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY(directive_id) REFERENCES directives(id)
);
`;
