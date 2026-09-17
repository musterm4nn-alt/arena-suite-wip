import type { RoutedEvent, RoutedEventInput } from '@arena/schema';

/**
 * Event routing + account stamping (plan §6.2, §5):
 * "Every event is routed by sessionId/targetId, then stamped with account_id
 * and session_epoch_id before entering any shared queue."
 *
 * The stamp is derived ONLY from supervisor-owned bindings; a page payload can
 * never set it (fuzz test target in P0/P3 gates).
 */

export interface TargetBinding {
  account_id: string;
  session_epoch_id: string;
  parentTargetId?: string;
  kind: 'page' | 'iframe' | 'dedicated_worker' | 'shared_worker' | 'service_worker' | 'other';
}

export class EventRouter {
  #bySession = new Map<string, TargetBinding>();       // cdp sessionId -> binding
  #byTarget = new Map<string, TargetBinding>();        // targetId -> binding
  #unboundPolicy: 'gap_record' | 'drop';
  #unboundCount = 0;

  constructor(opts: { unboundPolicy?: 'gap_record' | 'drop' } = {}) {
    this.#unboundPolicy = opts.unboundPolicy ?? 'gap_record';
  }

  bind(sessionId: string, targetId: string, binding: TargetBinding): void {
    this.#bySession.set(sessionId, binding);
    this.#byTarget.set(targetId, binding);
  }

  unbind(sessionId: string): void {
    const b = this.#bySession.get(sessionId);
    this.#bySession.delete(sessionId);
    if (b) {
      for (const [t, bb] of this.#byTarget) if (bb === b) this.#byTarget.delete(t);
    }
  }

  /** A child target attached via flatten: bind to the PARENT's account (§6.1). */
  bindChild(sessionId: string, targetId: string, parentTargetId: string, kind: TargetBinding['kind']): boolean {
    const parent = this.#byTarget.get(parentTargetId);
    if (!parent) return false; // unknown parent => no binding; events will be treated as unbound
    this.bind(sessionId, targetId, { ...parent, kind, parentTargetId });
    return true;
  }

  bindingFor(sessionId?: string, targetId?: string): TargetBinding | undefined {
    if (sessionId) {
      const b = this.#bySession.get(sessionId);
      if (b) return b;
    }
    if (targetId) return this.#byTarget.get(targetId);
    return undefined;
  }

  /**
   * Stamp an inbound event. `pageClaimedAccountId` models hostile page data;
   * it is ignored by construction — the return value can only carry the
   * supervisor-derived account. Returns null when unbound policy drops it
   * (after producing a gap diagnostic).
   */
  route(
    raw: Omit<RoutedEventInput, 'account_id' | 'session_epoch_id'>,
    opts: { sessionId?: string; targetId?: string; pageClaimedAccountId?: string }
  ): { event: RoutedEvent; unbound: false } | { event: RoutedEvent; unbound: true; gapReason: 'unbound_target' } | null {
    const binding = this.bindingFor(opts.sessionId, opts.targetId);
    if (!binding) {
      this.#unboundCount++;
      if (this.#unboundPolicy === 'drop') return null;
      return {
        event: { completeness: 'unknown', ...raw, account_id: 'unbound', kind: 'diagnostic', note: `unbound_target:${this.#unboundCount}` } as RoutedEvent,
        unbound: true,
        gapReason: 'unbound_target',
      };
    }
    return {
      event: { completeness: 'unknown', ...raw, account_id: binding.account_id, session_epoch_id: binding.session_epoch_id } as RoutedEvent,
      unbound: false,
    };
  }

  get unboundCount(): number { return this.#unboundCount; }
}
