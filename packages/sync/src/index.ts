/**
 * @arena/sync — read qualification + sync job semantics (plan §9).
 *
 * No autonomous replay without an owner-session probe establishing
 * account-binding, effective read-only behavior, and pagination stability.
 * Transport failures use bounded backoff; auth/suspected-mutation never retry.
 */
import type { SyncBlockingReason, SyncJobState } from "@arena/schema";

export interface ReadProbeResult {
  probeId: string;
  accountId: string;
  operationKey: string;
  /** Server-visible fingerprint before/after the single same-session replay. */
  fingerprintBefore: string;
  fingerprintAfter: string | null;
  /** True only when equivalence is ESTABLISHED, not merely not-disproven. */
  equivalenceEstablished: boolean;
  paginationStable: boolean;
  detailCrossChecked: boolean;
  verdict: "qualified" | "mutation_unknown" | "unstable" | "failed";
}

export function evaluateReadProbe(r: Omit<ReadProbeResult, "verdict">): ReadProbeResult {
  let verdict: ReadProbeResult["verdict"];
  if (r.fingerprintAfter === null) verdict = "failed";
  else if (r.fingerprintBefore !== r.fingerprintAfter) verdict = "mutation_unknown";
  else if (!r.equivalenceEstablished) verdict = "mutation_unknown";
  else if (!r.paginationStable) verdict = "unstable";
  else if (!r.detailCrossChecked) verdict = "failed";
  else verdict = "qualified";
  return { ...r, verdict };
}

// ---------------------------------------------------------------------------
// Job state machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<SyncJobState, SyncJobState[]> = {
  queued: ["running", "cancelled"],
  running: ["paused", "completed", "completed_with_gaps", "failed", "cancelled"],
  paused: ["running", "cancelled", "failed"],
  completed: [],
  completed_with_gaps: [],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransition(from: SyncJobState, to: SyncJobState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export interface SyncJob {
  id: string;
  accountId: string;
  state: SyncJobState;
  blockingReason: SyncBlockingReason;
  consecutiveFailures: number;
}

export function transitionJob(job: SyncJob, to: SyncJobState): SyncJob {
  if (!canTransition(job.state, to)) {
    throw new Error(`illegal sync transition ${job.state} -> ${to}`);
  }
  return { ...job, state: to };
}

// ---------------------------------------------------------------------------
// Backoff: bounded exponential with jitter, transport/429/5xx ONLY.
// ---------------------------------------------------------------------------

export type RetryableClass = "transport" | "rate_limited" | "server_5xx";
export type NonRetryableClass = "auth" | "suspected_mutation" | "challenge" | "drift";

export interface BackoffPlan {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffPlan = { baseMs: 1000, maxMs: 60_000, maxAttempts: 8 };

export function backoffDelayMs(
  attempt: number, // 1-based
  plan: BackoffPlan = DEFAULT_BACKOFF,
  jitter: () => number = Math.random,
): number | null {
  if (attempt < 1 || attempt > plan.maxAttempts) return null;
  const exp = Math.min(plan.maxMs, plan.baseMs * 2 ** (attempt - 1));
  return Math.floor(exp / 2 + jitter() * (exp / 2));
}

export function isRetryableClass(c: string): c is RetryableClass {
  return c === "transport" || c === "rate_limited" || c === "server_5xx";
}

// ---------------------------------------------------------------------------
// Pagination stability
// ---------------------------------------------------------------------------

export interface PageObservation {
  fingerprint: string;
  cursor: string | null;
  itemCount: number;
}

/** Returns "stable" | "pagination_instability" after re-walking one page. */
export function checkPaginationStability(
  first: PageObservation,
  repeat: PageObservation,
): "stable" | "pagination_instability" {
  if (first.fingerprint !== repeat.fingerprint) return "pagination_instability";
  if (first.cursor !== repeat.cursor) return "pagination_instability";
  return "stable";
}
