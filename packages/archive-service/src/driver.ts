/**
 * @arena/archive-service/driver — storage driver boundary.
 *
 * Production uses a SQLCipher-compatible SQLite binding (encrypted at rest,
 * WAL encrypted, FTS5). That binding is native and platform-sensitive
 * (Electron arm64, macOS 14+), so it lives behind this interface and is
 * selected at runtime. Tests and the P0 spike use the memory driver.
 *
 * The interface is deliberately narrow (journal-first): the first durable
 * write is always an append-only observations record (plan §10.3).
 */

export interface ObservationRow {
  id: string;
  account_id: string;
  session_epoch_id: string | null;
  mechanism: string;
  target_id: string | null;
  cdp_session_id: string | null;
  operation_key: string;
  adapter_id: string | null;
  adapter_version: string | null;
  observed_at_ms: number;
  completeness: string;
  evidence_ref: string | null;
  observer_gap: number; // 0/1
  payload_json: string | null; // sanitized evidence (small) — never secrets
}

export interface DriverStats {
  observations: number;
  accounts: number;
}

export interface ArchiveDriver {
  readonly name: string;
  /** Numbered, transactional, forward-only migration to `target`. */
  migrate(target: number): Promise<void>;
  currentVersion(): Promise<number>;
  insertObservation(row: ObservationRow): Promise<void>;
  getObservation(accountId: string, id: string): Promise<ObservationRow | null>;
  listObservations(accountId: string, limit: number, cursor: string | null): Promise<{
    rows: ObservationRow[];
    nextCursor: string | null;
  }>;
  stats(): Promise<DriverStats>;
  /** Integrity check + orphan recovery; returns human-readable findings. */
  integrityCheck(): Promise<string[]>;
  close(): Promise<void>;
}
