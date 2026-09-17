import type { DbHandle } from './db.ts';

/**
 * Numbered, transactional, forward-only migrations (plan §10.3).
 * A verified encrypted backup must precede real migrations on macOS;
 * the runner enforces the ordering contract (see archive-service maintenance).
 */
export interface Migration {
  version: number;
  name: string;
  up(db: DbHandle): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'identity_capture_core',
    up(db) {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

        CREATE TABLE account (
          account_id   TEXT PRIMARY KEY,           -- local UUID; durable archive key (§5, §10.1)
          label        TEXT NOT NULL DEFAULT '',
          enabled      INTEGER NOT NULL DEFAULT 1,
          created_at   INTEGER NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE partition_dir (
          account_id    TEXT PRIMARY KEY REFERENCES account(account_id),
          storage_path  TEXT NOT NULL,
          created_at    INTEGER NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE session_epoch (
          id          TEXT PRIMARY KEY,
          account_id  TEXT NOT NULL REFERENCES account(account_id),
          started_at  INTEGER NOT NULL,
          ended_at    INTEGER,
          status      TEXT NOT NULL CHECK (status IN ('active','ended','challenged'))
        );
        CREATE INDEX idx_epoch_account ON session_epoch(account_id, status);

        -- Append-only sanitized observation journal (§10.3: the DB is the journal).
        CREATE TABLE observation (
          id               INTEGER PRIMARY KEY,
          account_id       TEXT NOT NULL,
          session_epoch_id TEXT,
          mechanism        TEXT NOT NULL CHECK (mechanism IN
            ('cdp_network','cdp_websocket','cdp_eventsource','cdp_target','ui_witness',
             'download','import','probe','diagnostic')),
          operation_key    TEXT,                    -- method + masked path template
          target_id        TEXT,
          cdp_session_id   TEXT,
          request_id       TEXT,
          observed_at      INTEGER NOT NULL,
          kind             TEXT NOT NULL,           -- request|response_head|chunk_meta|stream_end|ui_state|...
          completeness     TEXT NOT NULL DEFAULT 'unknown',
          payload_json     TEXT,                    -- sanitized projection only; NULL when fail-closed
          payload_bytes    INTEGER,
          payload_shape_hash TEXT,
          sanitize_error   TEXT,
          artifact_id      TEXT                     -- sealed blob ref for large bodies
        );
        CREATE INDEX idx_obs_account ON observation(account_id, observed_at);
        CREATE INDEX idx_obs_request ON observation(account_id, request_id);
        CREATE INDEX idx_obs_epoch ON observation(session_epoch_id);

        CREATE TABLE conversation (
          id            TEXT PRIMARY KEY,
          account_id    TEXT NOT NULL REFERENCES account(account_id),
          external_ref  TEXT,                       -- observed Arena conversation id (evidence, not authority)
          source        TEXT NOT NULL CHECK (source IN ('live','backfill','import')),
          mode          TEXT NOT NULL DEFAULT 'unknown' CHECK (mode IN ('battle','direct','side_by_side','unknown')),
          first_observed_at INTEGER,
          last_observed_at  INTEGER,
          suppressed    INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_conv_account ON conversation(account_id, last_observed_at DESC);

        CREATE TABLE branch (
          id               TEXT PRIMARY KEY,
          conversation_id  TEXT NOT NULL REFERENCES conversation(id),
          parent_branch_id TEXT REFERENCES branch(id),
          origin           TEXT NOT NULL CHECK (origin IN ('initial','regeneration','retry','edit')),
          created_at       INTEGER NOT NULL
        );
        CREATE INDEX idx_branch_conv ON branch(conversation_id);

        CREATE TABLE turn (
          id              TEXT PRIMARY KEY,
          branch_id       TEXT NOT NULL REFERENCES branch(id),
          seq             INTEGER NOT NULL,
          role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
          completeness    TEXT NOT NULL,
          terminal_evidence_json TEXT,
          stream_stats_json      TEXT,
          started_at      INTEGER,
          ended_at        INTEGER,
          UNIQUE (branch_id, seq)
        );

        CREATE TABLE part (
          id       TEXT PRIMARY KEY,
          turn_id  TEXT NOT NULL REFERENCES turn(id),
          idx      INTEGER NOT NULL,
          kind     TEXT NOT NULL CHECK (kind IN
            ('text','reasoning','code','tool_call','tool_result','citation',
             'artifact_ref','vote','ui_state','unknown')),
          content_json TEXT NOT NULL,
          UNIQUE (turn_id, idx)
        );

        CREATE TABLE participant (
          id              TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversation(id),
          position        INTEGER NOT NULL,          -- 0-based slot
          blind_label     TEXT,                      -- "Model A" style label, may change (§10.1)
          selected_label  TEXT,
          resolved_name   TEXT,                      -- VIEW field; derived, never a mutation of evidence
          resolution      TEXT NOT NULL DEFAULT 'unresolved'
            CHECK (resolution IN ('unresolved','revealed','selected','request_catalog','inferred_experiment'))
        );

        -- Append-only identity evidence; scoped to the smallest supported range (§10.1).
        CREATE TABLE identity_claim (
          id             TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL REFERENCES participant(id),
          type           TEXT NOT NULL CHECK (type IN
            ('position','blind_label','selected_label','request_catalog_id','displayed_name','post_vote_reveal')),
          value          TEXT NOT NULL,
          scope_from     INTEGER,
          scope_to       INTEGER,
          observation_id INTEGER REFERENCES observation(id)
        );

        CREATE TABLE artifact (
          id            TEXT PRIMARY KEY,
          account_id    TEXT NOT NULL REFERENCES account(account_id),
          conversation_id TEXT REFERENCES conversation(id),
          turn_id         TEXT REFERENCES turn(id),
          filename_safe   TEXT NOT NULL,
          source_url_ref  TEXT,                       -- sanitized {host,path,query...} JSON
          size_bytes      INTEGER NOT NULL,
          sha256          TEXT NOT NULL,
          mime            TEXT NOT NULL,
          blob_path       TEXT NOT NULL,
          sealed_at       INTEGER NOT NULL,
          meta_json       TEXT
        );
        CREATE INDEX idx_artifact_account ON artifact(account_id);

        CREATE TABLE conflict (
          id          TEXT PRIMARY KEY,
          account_id  TEXT NOT NULL,
          kind        TEXT NOT NULL,                  -- ui_network_mismatch|sync_overlap|identity|pagination_instability|...
          detail_json TEXT NOT NULL,
          observation_ids TEXT,                        -- JSON array
          created_at  INTEGER NOT NULL,
          resolved_at INTEGER
        );

        -- Provenance links: field-level pointer from normalized rows to evidence (§10.2).
        CREATE TABLE provenance_link (
          entity_table  TEXT NOT NULL,
          entity_id     TEXT NOT NULL,
          field         TEXT NOT NULL,
          observation_id INTEGER NOT NULL REFERENCES observation(id),
          PRIMARY KEY (entity_table, entity_id, field, observation_id)
        ) WITHOUT ROWID;
      `);
    },
  },
  {
    version: 2,
    name: 'catalog_sync_deletion',
    up(db) {
      db.exec(`
        CREATE TABLE protocol_op (
          id            TEXT PRIMARY KEY,
          host_class    TEXT NOT NULL,
          method        TEXT NOT NULL,
          path_template TEXT NOT NULL,               -- identifiers masked as :id
          transport     TEXT NOT NULL CHECK (transport IN
            ('json','chunked','sse','websocket','download','rsc','unknown')),
          direction     TEXT NOT NULL CHECK (direction IN ('read','mutate','asset','auth','config','unknown')),
          evidence_state TEXT NOT NULL CHECK (evidence_state IN
            ('seen','classified','adapter_ready','owner_verified_read','deprecated')),
          account_binding_evidence TEXT,
          payload_family TEXT,
          shape_hash     TEXT,
          adapter_id     TEXT,
          adapter_version INTEGER NOT NULL DEFAULT 1,
          completeness_model TEXT,
          first_seen     INTEGER NOT NULL,
          last_seen      INTEGER NOT NULL,
          drift_shaped   INTEGER NOT NULL DEFAULT 0,
          drift_status   INTEGER NOT NULL DEFAULT 0,
          drift_unknown_fields INTEGER NOT NULL DEFAULT 0,
          drift_terminal INTEGER NOT NULL DEFAULT 0,
          ui_network_disagreement INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_protoop_tpl ON protocol_op(host_class, method, path_template);

        CREATE TABLE drift_event (
          id        TEXT PRIMARY KEY,
          op_id     TEXT NOT NULL REFERENCES protocol_op(id),
          kind      TEXT NOT NULL,                    -- shape_change|status_change|missing_terminal|unknown_fields
          detail_json TEXT NOT NULL,
          observed_at INTEGER NOT NULL
        );

        CREATE TABLE sync_job (
          id            TEXT PRIMARY KEY,
          account_id    TEXT NOT NULL REFERENCES account(account_id),
          state         TEXT NOT NULL CHECK (state IN
            ('queued','running','paused','completed','completed_with_gaps','failed','cancelled')),
          blocking_reason TEXT,
          adapter_version TEXT,
          run_seq       INTEGER NOT NULL DEFAULT 0,
          started_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          finished_at   INTEGER,
          error_json    TEXT
        );
        CREATE INDEX idx_syncjob_account ON sync_job(account_id, started_at DESC);

        CREATE TABLE sync_checkpoint (
          job_id      TEXT NOT NULL REFERENCES sync_job(id),
          seq         INTEGER NOT NULL,
          cursor_json TEXT NOT NULL,
          page_fingerprint TEXT NOT NULL,
          seen_digest TEXT NOT NULL,
          counts_json TEXT NOT NULL,
          adapter_version TEXT NOT NULL,
          run_seq     INTEGER NOT NULL,
          committed_at INTEGER NOT NULL,
          PRIMARY KEY (job_id, seq)
        ) WITHOUT ROWID;

        CREATE TABLE delete_directive (
          id          TEXT PRIMARY KEY,               -- random, single-use
          scope       TEXT NOT NULL CHECK (scope IN ('conversation','account','archive')),
          scope_ids   TEXT NOT NULL,                  -- JSON array of canonical ids
          item_count  INTEGER NOT NULL,
          scope_hash  TEXT NOT NULL,                  -- sha256(canonical scope + nonce)
          nonce_hash  TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          used_at     INTEGER
        );

        CREATE TABLE tombstone (
          id          TEXT PRIMARY KEY,
          account_id  TEXT NOT NULL,
          scope       TEXT NOT NULL,
          target_id   TEXT NOT NULL,
          scope_hash  TEXT NOT NULL,
          directive_id TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_tombstone_target ON tombstone(target_id);

        CREATE TABLE suppression_marker (
          target_id TEXT PRIMARY KEY,
          reason    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE analysis_run (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL,
          corpus_hash  TEXT NOT NULL,
          code_version TEXT NOT NULL,
          config_json  TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          report_json  TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: 'fts_search',
    up(db) {
      db.exec(`
        CREATE VIRTUAL TABLE part_fts USING fts5(
          text,
          part_id UNINDEXED,
          turn_id UNINDEXED,
          account_id UNINDEXED,
          tokenize = 'unicode61'
        );
      `);
    },
  },
];

export function currentVersion(db: DbHandle): number {
  const row = db.prepare(`SELECT m.version FROM _migrations m ORDER BY m.version DESC LIMIT 1`).get() as { version: number } | undefined;
  if (row) return row.version;
  db.exec(`CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, sha256 TEXT NOT NULL) WITHOUT ROWID`);
  return 0;
}
