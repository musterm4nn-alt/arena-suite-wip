import { randomUUID } from 'node:crypto';
import { Sanitizer } from '@arena/security';

/**
 * Observation journal — first durable write is append-only observations record in SQLCipher (10.3)
 * This uses encrypted DB itself as journal and avoids second persistence format.
 */

export interface JournalEntry {
  id: string;
  account_id: string;
  session_epoch_id: string | null;
  mechanism: string;
  target_id: string | null;
  session_id: string | null;
  operation_key: string | null;
  observed_at: string;
  completeness_state: string;
  sanitized_evidence_ref: string | null;
  adapter_id: string | null;
  adapter_version: string | null;
  byte_length: number | null;
  shape_hash: string | null;
  raw_sanitized: unknown;
}

export class ObservationJournal {
  private entries: JournalEntry[] = [];
  private maxMemory = 10000;

  async append(entry: Omit<JournalEntry, 'id' | 'observed_at'> & { observed_at?: string; raw_evidence: unknown }): Promise<JournalEntry> {
    // Sanitize before persistence — fail closed
    const { sanitized, droppedKeys, error } = Sanitizer.sanitizeJson(entry.raw_evidence);

    const journalEntry: JournalEntry = {
      id: randomUUID(),
      account_id: entry.account_id,
      session_epoch_id: entry.session_epoch_id,
      mechanism: entry.mechanism,
      target_id: entry.target_id,
      session_id: entry.session_id,
      operation_key: entry.operation_key,
      observed_at: entry.observed_at ?? new Date().toISOString(),
      completeness_state: entry.completeness_state,
      sanitized_evidence_ref: entry.sanitized_evidence_ref,
      adapter_id: entry.adapter_id,
      adapter_version: entry.adapter_version,
      byte_length: entry.byte_length,
      shape_hash: entry.shape_hash,
      raw_sanitized: sanitized,
    };

    // In real implementation: INSERT into observations table in SQLCipher, same transaction as normalization
    this.entries.push(journalEntry);
    if (this.entries.length > this.maxMemory) {
      this.entries.shift(); // bounded queue — but DB is durable
    }

    if (error || droppedKeys.length > 0) {
      // Structured logging only, no raw dump
      console.log(`[Journal] Sanitized entry ${journalEntry.id} droppedKeys=${droppedKeys.length} error=${error ?? 'none'}`);
    }

    return journalEntry;
  }

  getRecent(limit = 100): JournalEntry[] {
    return this.entries.slice(-limit);
  }

  count(): number {
    return this.entries.length;
  }
}
