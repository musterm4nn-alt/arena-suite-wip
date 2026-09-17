/**
 * Event routing — every event is routed by sessionId/targetId, then stamped with account_id and session_epoch_id
 * before entering any shared queue (section 6.2)
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string; // flattened CDP session
  targetId?: string;
  timestamp: number;
}

export interface RoutedEvent extends CdpEvent {
  accountId: string;
  sessionEpochId: string | null;
  routedAt: number;
}

export type AccountResolver = (sessionId?: string, targetId?: string) => { accountId: string; sessionEpochId: string | null } | null;

export class EventRouter {
  constructor(private resolveAccount: AccountResolver) {}

  route(event: CdpEvent): RoutedEvent | null {
    const binding = this.resolveAccount(event.sessionId, event.targetId);
    if (!binding) {
      // No account binding — this is an observer gap, not silent drop
      return null;
    }
    return {
      ...event,
      accountId: binding.accountId,
      sessionEpochId: binding.sessionEpochId,
      routedAt: Date.now(),
    };
  }

  routeBatch(events: CdpEvent[]): { routed: RoutedEvent[]; gaps: CdpEvent[] } {
    const routed: RoutedEvent[] = [];
    const gaps: CdpEvent[] = [];
    for (const ev of events) {
      const r = this.route(ev);
      if (r) routed.push(r);
      else gaps.push(ev);
    }
    return { routed, gaps };
  }
}
