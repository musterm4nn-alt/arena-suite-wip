/**
 * @arena/capture-core/router — capture authority (plan §5, "Capture authority").
 *
 * Every CDP event is routed by (cdpSessionId, targetId) to the owning
 * CaptureSupervisor, which stamps account_id + session_epoch_id. Page payloads
 * CANNOT set account identity: any account-like field inside event params is
 * ignored for routing and flagged for the fuzz/canary tests.
 */

export interface SupervisorBinding {
  accountId: string;
  epochId: string | null;
}

export interface RoutedEvent<TParams = unknown> {
  accountId: string;
  epochId: string | null;
  targetId: string | null;
  cdpSessionId: string | null;
  method: string;
  params: TParams;
  /** True if the payload contained suspicious account-like fields (ignored). */
  payloadAccountFieldIgnored: boolean;
}

const ACCOUNT_LIKE_KEYS = new Set([
  "accountId",
  "account_id",
  "accountUuid",
  "account_uuid",
  "ownerId",
  "owner_id",
  "userId",
  "user_id",
  "email",
]);

export class CaptureRouter {
  /** cdpSessionId -> binding */
  private readonly bySession = new Map<string, SupervisorBinding>();
  /** targetId -> binding (fallback when sessionId is absent, e.g. some Target events) */
  private readonly byTarget = new Map<string, SupervisorBinding>();

  bindSession(cdpSessionId: string, binding: SupervisorBinding): void {
    this.bySession.set(cdpSessionId, { ...binding });
  }

  bindTarget(targetId: string, binding: SupervisorBinding): void {
    this.byTarget.set(targetId, { ...binding });
  }

  unbindSession(cdpSessionId: string): void {
    this.bySession.delete(cdpSessionId);
  }

  unbindTarget(targetId: string): void {
    this.byTarget.delete(targetId);
  }

  /**
   * Route one CDP event. Returns null when the session/target is unbound —
   * unbound events are dropped (and counted by the caller), never guessed
   * into an account.
   */
  route<TParams>(event: {
    method: string;
    params?: TParams;
    cdpSessionId?: string | null;
    targetId?: string | null;
  }): RoutedEvent<TParams> | null {
    let binding: SupervisorBinding | undefined;
    if (event.cdpSessionId) binding = this.bySession.get(event.cdpSessionId);
    if (!binding && event.targetId) binding = this.byTarget.get(event.targetId);
    if (!binding) return null;

    const params = (event.params ?? {}) as TParams;
    return {
      accountId: binding.accountId,
      epochId: binding.epochId,
      targetId: event.targetId ?? null,
      cdpSessionId: event.cdpSessionId ?? null,
      method: event.method,
      params,
      payloadAccountFieldIgnored: containsAccountLikeField(params),
    };
  }
}

function containsAccountLikeField(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return false;
  if (Array.isArray(params)) return params.some(containsAccountLikeField);
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (ACCOUNT_LIKE_KEYS.has(k)) return true;
    if (typeof v === "object" && v !== null && containsAccountLikeField(v)) {
      return true;
    }
  }
  return false;
}
