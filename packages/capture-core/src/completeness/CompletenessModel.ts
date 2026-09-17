/**
 * Completeness, reconciliation, and branches per section 7
 */

export type CompletenessState =
  | 'complete'
  | 'stopped_by_user'
  | 'failed_transport'
  | 'partial_stream'
  | 'observer_gap'
  | 'reconstructed_ui_only'
  | 'imported'
  | 'unknown';

export interface CompletenessEvidence {
  hasPositiveTerminal: boolean;
  hasObserverGap: boolean;
  hasStopSignal: boolean;
  hasTransportFailure: boolean;
  hasOnlyUiEvidence: boolean;
  isImported: boolean;
  byteLength: number;
  gapIntervals: Array<{ reason: string }>;
}

export class CompletenessModel {
  static evaluate(ev: CompletenessEvidence): CompletenessState {
    if (ev.isImported) return 'imported';
    if (ev.hasOnlyUiEvidence) return 'reconstructed_ui_only';
    if (ev.hasObserverGap || ev.gapIntervals.length > 0) return 'observer_gap';
    if (ev.hasTransportFailure) return 'failed_transport';
    if (ev.hasStopSignal) return 'stopped_by_user';
    if (!ev.hasPositiveTerminal) {
      if (ev.byteLength > 0) return 'partial_stream';
      return 'unknown';
    }
    // Positive terminal + no gap = complete
    if (ev.hasPositiveTerminal && !ev.hasObserverGap) return 'complete';
    return 'unknown';
  }

  static canPromote(from: CompletenessState, to: CompletenessState): boolean {
    // Later history read may promote partial to complete only if unambiguous same account/conversation/branch/revision
    const allowed: Record<CompletenessState, CompletenessState[]> = {
      partial_stream: ['complete'],
      observer_gap: ['complete', 'partial_stream'],
      unknown: ['complete', 'partial_stream', 'reconstructed_ui_only'],
      reconstructed_ui_only: ['complete', 'partial_stream'],
      imported: [],
      complete: [],
      stopped_by_user: [],
      failed_transport: [],
    };
    return allowed[from]?.includes(to) ?? false;
  }

  static defaultIncludedForAnalysis(state: CompletenessState): boolean {
    return state === 'complete';
  }
}
