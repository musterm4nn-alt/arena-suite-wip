import { SyncJobManager, type SyncJob } from './SyncJob.js';

/**
 * Independent per-account jobs; start with global concurrency 2 and one request at a time per account
 * Bounded exponential backoff with jitter for transport/429/5xx only. Never retry auth failure or suspected mutation.
 */

export class SyncScheduler {
  private jobManager = new SyncJobManager();
  private backoff = new Map<string, { attempts: number; nextRetryAt: number }>();

  constructor(private globalConcurrency = 2) {}

  createJob(accountId: string, method: SyncJob['listing_method'] = 'api_replay'): SyncJob {
    return this.jobManager.create(accountId, method);
  }

  async runJob(jobId: string, executor: (job: SyncJob) => Promise<{ completed: boolean; withGaps?: boolean; blockingReason?: SyncJob['blocking_reason'] }>): Promise<SyncJob | null> {
    const job = this.jobManager.get(jobId);
    if (!job) return null;

    // Check backoff
    const bo = this.backoff.get(jobId);
    if (bo && Date.now() < bo.nextRetryAt) {
      return job;
    }

    this.jobManager.setState(jobId, 'running');

    try {
      const result = await executor(job);
      if (result.completed) {
        this.jobManager.setState(jobId, result.withGaps ? 'completed_with_gaps' : 'completed');
        this.backoff.delete(jobId);
      } else if (result.blockingReason && result.blockingReason !== 'none') {
        // Auth failure or mutation — never retry automatically
        if (result.blockingReason === 'auth' || result.blockingReason === 'account_mismatch') {
          this.jobManager.setState(jobId, 'failed', result.blockingReason);
        } else {
          // Transport/429/5xx — bounded exponential backoff with jitter
          this.applyBackoff(jobId);
          this.jobManager.setState(jobId, 'paused', result.blockingReason);
        }
      }
      return this.jobManager.get(jobId) ?? null;
    } catch (e) {
      // Transport failure — backoff
      this.applyBackoff(jobId);
      this.jobManager.setState(jobId, 'paused', 'rate_limit');
      return this.jobManager.get(jobId) ?? null;
    }
  }

  private applyBackoff(jobId: string): void {
    const prev = this.backoff.get(jobId) ?? { attempts: 0, nextRetryAt: 0 };
    const attempts = prev.attempts + 1;
    if (attempts > 5) {
      // Max retries reached — fail
      this.jobManager.setState(jobId, 'failed', 'rate_limit');
      this.backoff.delete(jobId);
      return;
    }
    const base = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s, 16s, 32s
    const jitter = Math.random() * 1000;
    const nextRetryAt = Date.now() + base + jitter;
    this.backoff.set(jobId, { attempts, nextRetryAt });
  }

  getJobManager(): SyncJobManager {
    return this.jobManager;
  }
}
