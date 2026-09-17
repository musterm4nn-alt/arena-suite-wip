import type { CompletenessState } from '@arena/schema';

/**
 * Completeness determination (plan §7). A turn becomes `complete` only from
 * POSITIVE terminal evidence and absence of a known observer gap.
 * Analysis default per state is data, not policy: it is exported so every
 * consumer shares one definition.
 */
export const ANALYSIS_DEFAULT: Record<CompletenessState, 'included' | 'excluded' | 'excluded_from_wire_timing' | 'separate_cohort'> = {
  complete: 'included',
  stopped_by_user: 'excluded',
  failed_transport: 'excluded',
  partial_stream: 'excluded',
  observer_gap: 'excluded',
  reconstructed_ui_only: 'excluded_from_wire_timing', // 'excluded' from wire-timing claims only
  imported: 'separate_cohort',
  unknown: 'excluded',
} as const;

export interface TerminalEvidence {
  transportFinished?: boolean;
  transportFailed?: { reason: string };
  parserTerminal?: boolean;        // e.g. SSE [DONE], ws close frame, terminal JSON record
  userAbortEvidence?: boolean;     // stop-button witness / client cancel record
  contentPresent?: boolean;
  onlyUiEvidence?: boolean;        // no wire bytes at all
  observerGap?: { reason: string }[]; // e.g. queue overflow during stream, detach window
  contextLoss?: { reason: string };   // renderer gone / navigated away mid-stream
  imported?: boolean;
}

/**
 * Deterministic reducer over the evidence set. Precedence is explicit and
 * documented; it never guesses (§2 rule 1). Order of checks matters:
 *  observer gap first (we cannot trust absence), then abort, transport fail,
 *  complete requires BOTH terminals, then partial, UI-only, imported.
 */
export function decideCompleteness(e: TerminalEvidence): CompletenessState {
  if (e.observerGap && e.observerGap.length > 0) return 'observer_gap';
  if (e.userAbortEvidence) return 'stopped_by_user';
  if (e.transportFailed) return 'failed_transport';
  if (e.transportFinished && e.parserTerminal) return 'complete';
  if (e.onlyUiEvidence) return 'reconstructed_ui_only';
  if (e.contentPresent) return 'partial_stream';
  if (e.contextLoss) return 'observer_gap';
  if (e.imported) return 'imported';
  return 'unknown';
}

/**
 * Promotion (§7): a later history read may promote a partial turn to complete
 * ONLY with unambiguous same account/conversation/branch/revision coverage and
 * reconciled content. Promotion is additive: provenance event appended, the
 * original gap evidence remains.
 */
export interface TurnRef { account_id: string; conversation_id: string; branch_id: string; revision: string }

export function sameTurnRef(a: TurnRef, b: TurnRef): boolean {
  return a.account_id === b.account_id && a.conversation_id === b.conversation_id
    && a.branch_id === b.branch_id && a.revision === b.revision;
}

export interface PromotionInput {
  current: CompletenessState;
  historyTurn: TurnRef;
  liveTurn: TurnRef;
  historyCompleteness: CompletenessState;
  contentDigestLive: string;
  contentDigestHistory: string;
}

export type PromotionResult =
  | { promote: true; reason: 'reconciled' }
  | { promote: false; reason: 'state_not_promotable' | 'scope_mismatch' | 'history_not_complete' | 'content_mismatch' };

export function canPromote(p: PromotionInput): PromotionResult {
  if (p.current !== 'partial_stream' && p.current !== 'stopped_by_user' && p.current !== 'observer_gap' && p.current !== 'unknown') {
    return { promote: false, reason: 'state_not_promotable' };
  }
  if (!sameTurnRef(p.liveTurn, p.historyTurn)) return { promote: false, reason: 'scope_mismatch' };
  if (p.historyCompleteness !== 'complete') return { promote: false, reason: 'history_not_complete' };
  if (p.contentDigestLive !== p.contentDigestHistory) return { promote: false, reason: 'content_mismatch' };
  return { promote: true, reason: 'reconciled' };
}

/**
 * A promotion NEVER overwrites gap evidence; it returns the state plus an
 * append-only provenance record describing the promotion source.
 */
export function promotionProvenance(input: PromotionInput, historyObservationIds: number[]) {
  return {
    kind: 'completeness_promotion',
    from: input.current,
    to: 'complete' as const,
    history_observation_ids: historyObservationIds,
    content_digest: input.contentDigestHistory,
    note: 'original gap evidence retained',
  };
}
