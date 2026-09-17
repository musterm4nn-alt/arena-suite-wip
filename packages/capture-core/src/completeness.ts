/**
 * @arena/capture-core/completeness — completeness derivation (plan §7).
 *
 * A turn becomes `complete` ONLY from positive terminal evidence AND the
 * absence of a known observer gap. Everything else maps to an explicit
 * non-complete state. There is no path that guesses `complete`.
 */
import type { Completeness, TerminalSignal } from "@arena/schema";

export interface TurnEnding {
  /** Parser observed a valid terminal record for the payload family. */
  parserTerminal: boolean;
  transportTerminal: TerminalSignal | null;
  /** Observer knows it was absent/evicted, or the ledger has gaps. */
  observerGap: boolean;
  /** Owner/client abort evidence exists. */
  userStop: boolean;
  /** Only rendered-state (isolated witness) evidence exists. */
  uiOnly: boolean;
  /** Imported from prior archive/export. */
  imported: boolean;
}

export function deriveCompleteness(ending: TurnEnding): Completeness {
  if (ending.imported) return "imported";
  if (ending.observerGap) return "observer_gap";
  if (ending.userStop) return "stopped_by_user";
  if (
    ending.transportTerminal === "loading_failed" ||
    ending.transportTerminal === "target_destroyed"
  ) {
    return "failed_transport";
  }
  if (ending.uiOnly && !ending.parserTerminal) return "reconstructed_ui_only";
  if (ending.parserTerminal) {
    // Positive terminal evidence + no gap (checked above) => complete.
    return "complete";
  }
  // Content may exist but the stream ended without a valid terminal signal.
  if (
    ending.transportTerminal === "transport_close" ||
    ending.transportTerminal === "loading_finished" ||
    ending.transportTerminal === "response_close" ||
    ending.transportTerminal === "evicted"
  ) {
    return "partial_stream";
  }
  if (ending.transportTerminal === null || ending.transportTerminal === "unknown") {
    return "unknown";
  }
  return "unknown";
}

/**
 * Promotion rule (plan §7): a later history read may promote partial -> complete
 * only if it unambiguously covers the same account/conversation/branch/revision
 * and reconciles the content. Returns the promoted state or the original.
 */
export function maybePromoteCompleteness(opts: {
  current: Completeness;
  sameScope: boolean;
  contentReconciled: boolean;
  gapCovered: boolean;
}): Completeness {
  const { current, sameScope, contentReconciled, gapCovered } = opts;
  if (current !== "partial_stream" && current !== "observer_gap") return current;
  if (sameScope && contentReconciled && gapCovered) return "complete";
  return current;
}
