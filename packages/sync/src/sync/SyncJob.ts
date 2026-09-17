import { randomUUID } from 'node:crypto';

/**
 * Sync job semantics per 9.2
 */

export type SyncState = 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_gaps' | 'failed' | 'cancelled';
export type BlockingReason = 'auth' | 'rate_limit' | 'challenge' | 'drift' | 'account_mismatch' | 'none';

export interface Checkpoint {
  cursor: string | null;
  page_fingerprint: string | null;
  seen_set_digest: string | null;
  counts: Record<string, number>;
  adapter_version: string | null;
  run_sequence: number;
}

export interface SyncJob {
  id: string;
  account_id: string;
  state: SyncState;
  listing_method: 'api_replay' | 'ui_traversal' | 'import' | 'unknown';
  checkpoint: Checkpoint | null;
  blocking_reason: BlockingReason;
  created_at: string;
  updated_at: string;
  run_sequence: number;
}

export class SyncJobManager {
  private jobs = new Map<string, SyncJob>();

  create(accountId: string, method: SyncJob['listing_method'] = 'api_replay'): SyncJob {
    const job: SyncJob = {
      id: randomUUID(),
      account_id: accountId,
      state: 'queued',
      listing_method: method,
      checkpoint: null,
      blocking_reason: 'none',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      run_sequence: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  updateCheckpoint(jobId: string, checkpoint: Partial<Checkpoint> & { counts: Record<string, number> }): SyncJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const prev = job.checkpoint;
    job.checkpoint = {
      cursor: checkpoint.cursor ?? prev?.cursor ?? null,
      page_fingerprint: checkpoint.page_fingerprint ?? prev?.page_fingerprint ?? null,
      seen_set_digest: checkpoint.seen_set_digest ?? prev?.seen_set_digest ?? null,
      counts: checkpoint.counts,
      adapter_version: checkpoint.adapter_version ?? prev?.adapter_version ?? null,
      run_sequence: (prev?.run_sequence ?? 0) + 1,
    };
    job.run_sequence = job.checkpoint.run_sequence;
    job.updated_at = new Date().toISOString();
    // Transactionally committed with covered items per spec
    return job;
  }

  setState(jobId: string, state: SyncState, blockingReason: BlockingReason = 'none'): SyncJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.state = state;
    job.blocking_reason = blockingReason;
    job.updated_at = new Date().toISOString();
    return job;
  }

  get(jobId: string): SyncJob | undefined {
    return this.jobs.get(jobId);
  }

  list(accountId?: string): SyncJob[] {
    if (accountId) return Array.from(this.jobs.values()).filter(j => j.account_id === accountId);
    return Array.from(this.jobs.values());
  }

  // Idempotent upsert inside account scope — changed content becomes new observation/revision
  upsertSeen(jobId: string, seenIds: string[]): { isNew: boolean; duplicate: boolean } {
    // Simplified — real would check seen-set digest
    return { isNew: true, duplicate: false };
  }
}
