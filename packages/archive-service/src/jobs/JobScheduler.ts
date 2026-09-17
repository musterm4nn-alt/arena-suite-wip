/**
 * Sync scheduler / jobs per section 9.2
 * One queue, token bucket, cursor/checkpoint chain and auth state per account
 */

export type JobState = 'queued' | 'running' | 'paused' | 'completed' | 'completed_with_gaps' | 'failed' | 'cancelled';
export type BlockingReason = 'auth' | 'rate_limit' | 'challenge' | 'drift' | 'account_mismatch' | 'none';

export interface Job {
  id: string;
  account_id: string;
  type: 'sync' | 'analysis' | 'backup' | 'deletion';
  state: JobState;
  blocking_reason: BlockingReason;
  created_at: string;
  updated_at: string;
  checkpoint: unknown | null;
  attempts: number;
}

export class JobScheduler {
  private jobs = new Map<string, Job>();
  private perAccountConcurrency = new Map<string, number>();
  private globalConcurrency = 2; // start with 2 per spec
  private runningCount = 0;

  enqueue(job: Omit<Job, 'created_at' | 'updated_at' | 'attempts'> & { checkpoint?: unknown }): Job {
    const full: Job = {
      ...job,
      checkpoint: job.checkpoint ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      attempts: 0,
    };
    this.jobs.set(full.id, full);
    return full;
  }

  canRun(accountId: string): boolean {
    if (this.runningCount >= this.globalConcurrency) return false;
    const perAccount = this.perAccountConcurrency.get(accountId) ?? 0;
    if (perAccount >= 1) return false; // one request at a time per account
    return true;
  }

  start(jobId: string): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (!this.canRun(job.account_id)) return null;
    job.state = 'running';
    job.updated_at = new Date().toISOString();
    job.attempts++;
    this.runningCount++;
    this.perAccountConcurrency.set(job.account_id, (this.perAccountConcurrency.get(job.account_id) ?? 0) + 1);
    return job;
  }

  pause(jobId: string, reason: BlockingReason): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.state = 'paused';
    job.blocking_reason = reason;
    job.updated_at = new Date().toISOString();
    if (this.runningCount > 0) this.runningCount--;
    const per = this.perAccountConcurrency.get(job.account_id) ?? 1;
    this.perAccountConcurrency.set(job.account_id, Math.max(0, per - 1));
    return job;
  }

  complete(jobId: string, withGaps = false): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.state = withGaps ? 'completed_with_gaps' : 'completed';
    job.blocking_reason = 'none';
    job.updated_at = new Date().toISOString();
    if (this.runningCount > 0) this.runningCount--;
    const per = this.perAccountConcurrency.get(job.account_id) ?? 1;
    this.perAccountConcurrency.set(job.account_id, Math.max(0, per - 1));
    return job;
  }

  fail(jobId: string, reason: BlockingReason): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.state = 'failed';
    job.blocking_reason = reason;
    job.updated_at = new Date().toISOString();
    if (this.runningCount > 0) this.runningCount--;
    const per = this.perAccountConcurrency.get(job.account_id) ?? 1;
    this.perAccountConcurrency.set(job.account_id, Math.max(0, per - 1));
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  listByAccount(accountId: string): Job[] {
    return Array.from(this.jobs.values()).filter(j => j.account_id === accountId);
  }

  getStats() {
    return {
      total: this.jobs.size,
      running: this.runningCount,
      globalConcurrency: this.globalConcurrency,
      perAccount: Object.fromEntries(this.perAccountConcurrency),
    };
  }
}
