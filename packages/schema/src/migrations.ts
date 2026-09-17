/**
 * Schema migrations — per §10.3
 * Numbered, transactional, forward-only, preceded by verified encrypted backup
 */

export interface Migration {
  version: number;
  name: string;
  up: string; // SQL
  down?: string; // not used, forward-only, but kept for reference
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_observations",
    up: `
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        session_epoch_id TEXT NOT NULL,
        mechanism TEXT NOT NULL,
        target_id TEXT,
        session_id TEXT,
        operation_key TEXT,
        adapter_id TEXT,
        adapter_version TEXT,
        observed_at TEXT NOT NULL,
        completeness_state TEXT,
        sanitized_evidence_ref TEXT,
        byte_length INTEGER,
        shape_hash TEXT,
        provenance_chain TEXT -- JSON array
      );
      CREATE INDEX IF NOT EXISTS idx_observations_account ON observations(account_id);
      CREATE INDEX IF NOT EXISTS idx_observations_session_epoch ON observations(session_epoch_id);
      CREATE INDEX IF NOT EXISTS idx_observations_observed_at ON observations(observed_at);
    `,
  },
  {
    version: 2,
    name: "conversations_branches_turns",
    up: `
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT,
        branch_ids TEXT -- JSON array
      );
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        parent_branch_id TEXT,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id)
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        role TEXT NOT NULL,
        completeness TEXT NOT NULL,
        created_at TEXT NOT NULL,
        parts TEXT NOT NULL, -- JSON array of TurnPart
        participant_position INTEGER,
        blind_label TEXT,
        selected_label TEXT,
        revealed_identity TEXT,
        stop_reason TEXT,
        provenance TEXT NOT NULL, -- JSON
        FOREIGN KEY(conversation_id) REFERENCES conversations(id),
        FOREIGN KEY(branch_id) REFERENCES branches(id)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_account ON turns(account_id);
      CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id);
    `,
  },
  {
    version: 3,
    name: "artifacts",
    up: `
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT,
        source_url_safe_ref TEXT, -- JSON SafeUrlRef
        mime TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        sealed_blob_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provenance_observation_ids TEXT NOT NULL -- JSON array
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_account ON artifacts(account_id);
    `,
  },
  {
    version: 4,
    name: "sync_jobs_checkpoints",
    up: `
      CREATE TABLE IF NOT EXISTS sync_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        checkpoint TEXT, -- JSON
        blocking_reason TEXT,
        coverage TEXT -- JSON CoverageReport
      );
      CREATE TABLE IF NOT EXISTS sync_checkpoints (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        cursor TEXT,
        page_fingerprint TEXT,
        seen_set_digest TEXT,
        counts TEXT NOT NULL, -- JSON
        adapter_version TEXT NOT NULL,
        run_sequence INTEGER NOT NULL,
        committed_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES sync_jobs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sync_jobs_account ON sync_jobs(account_id);
    `,
  },
  {
    version: 5,
    name: "protocol_catalog_drift",
    up: `
      CREATE TABLE IF NOT EXISTS protocol_ops (
        id TEXT PRIMARY KEY,
        host_class TEXT NOT NULL,
        method TEXT NOT NULL,
        path_template TEXT NOT NULL,
        transport TEXT NOT NULL,
        direction TEXT NOT NULL,
        evidence_state TEXT NOT NULL,
        account_binding_evidence TEXT,
        payload_family TEXT NOT NULL,
        shape_hash TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        completeness_model TEXT,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        drift_counters TEXT NOT NULL -- JSON
      );
      CREATE TABLE IF NOT EXISTS drift_events (
        id TEXT PRIMARY KEY,
        op_id TEXT NOT NULL,
        type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        old_shape_hash TEXT,
        new_shape_hash TEXT,
        details TEXT NOT NULL, -- JSON
        adapter_id TEXT NOT NULL,
        FOREIGN KEY(op_id) REFERENCES protocol_ops(id)
      );
    `,
  },
  {
    version: 6,
    name: "accounts_partitions_epochs",
    up: `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        partition_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS session_epochs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(id)
      );
      CREATE TABLE IF NOT EXISTS delete_directives (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        account_id TEXT,
        conversation_ids TEXT, -- JSON array
        canonical_scope_hash TEXT NOT NULL,
        count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        nonce TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS delete_tombstones (
        id TEXT PRIMARY KEY,
        directive_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        account_id TEXT,
        conversation_id TEXT,
        deleted_at TEXT NOT NULL,
        FOREIGN KEY(directive_id) REFERENCES delete_directives(id)
      );
    `,
  },
  {
    version: 7,
    name: "fts5_and_provenance",
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        turn_id,
        account_id,
        conversation_id,
        text,
        tokenize='porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS provenance_links (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        observation_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        FOREIGN KEY(turn_id) REFERENCES turns(id),
        FOREIGN KEY(observation_id) REFERENCES observations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_provenance_turn ON provenance_links(turn_id);
      CREATE INDEX IF NOT EXISTS idx_provenance_obs ON provenance_links(observation_id);
    `,
  },
];

export function getLatestVersion(): number {
  return Math.max(...MIGRATIONS.map((m) => m.version));
}

export function getMigrationSqlUpTo(version: number): string {
  return MIGRATIONS.filter((m) => m.version <= version)
    .sort((a, b) => a.version - b.version)
    .map((m) => m.up)
    .join("\n");
}
