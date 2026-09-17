/**
 * Completeness model per §7
 */

import { CompletenessState } from "@arena-archive/schema";

export interface CompletenessEvidence {
  hasPositiveTerminal: boolean;
  hasObserverGap: boolean;
  hasStopSignal: boolean;
  hasTransportFailure: boolean;
  hasOnlyUiEvidence: boolean;
  isImported: boolean;
}

export function determineCompleteness(ev: CompletenessEvidence): CompletenessState {
  if (ev.isImported) return "imported";
  if (ev.hasOnlyUiEvidence) return "reconstructed_ui_only";
  if (ev.hasObserverGap) return "observer_gap";
  if (ev.hasTransportFailure) return "failed_transport";
  if (ev.hasStopSignal) return "stopped_by_user";
  if (!ev.hasPositiveTerminal) return "partial_stream";
  if (ev.hasPositiveTerminal && !ev.hasObserverGap) return "complete";
  return "unknown";
}

export function canIncludeInAnalysis(state: CompletenessState): boolean {
  return state === "complete";
}

export function canPromotePartialToComplete(params: {
  existing: CompletenessState;
  sameAccount: boolean;
  sameConversation: boolean;
  sameBranch: boolean;
  sameRevision: boolean;
  contentReconciles: boolean;
}): boolean {
  return (
    params.existing === "partial_stream" &&
    params.sameAccount &&
    params.sameConversation &&
    params.sameBranch &&
    params.sameRevision &&
    params.contentReconciles
  );
}
