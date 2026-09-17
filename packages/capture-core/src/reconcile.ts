import { sha256Hex } from '@arena/core';
import type { WitnessMessage } from '@arena/schema';

/**
 * UI/network reconciliation (§6.4 corroboration, §7 reconstructed_ui_only).
 * Disagreements are recorded as conflicts and never silently resolved in
 * favor of either witness.
 */

export interface LiveTurnWireEvidence {
  assembledTextDigest: string; // sha256 of final wire text
  partCount: number;
  order: string[];             // part ids in wire order
  terminal: boolean;
  participantLabels: { position: number; label: string }[];
}

export type ReconcileResult =
  | { agreement: 'full' }
  | { agreement: 'conflict'; kind: ConflictKind; detail: Record<string, unknown> };

type ConflictKind =
  | 'ui_text_differs'
  | 'ui_order_differs'
  | 'ui_reports_more_parts'
  | 'ui_stop_state_differs'
  | 'identity_label_disagreement'
  | 'wire_missing_ui_missing';

export function reconcileWireWithWitness(
  wire: LiveTurnWireEvidence,
  witness: { message: WitnessMessage; renderedText: string; stopState?: 'none' | 'stopped_by_user' | 'transport_error' | 'unknown' },
  opts: { trustWireContent: boolean } = { trustWireContent: true }
): ReconcileResult {
  const uiDigest = sha256Hex(normalizeText(witness.renderedText));
  const wireDigest = normalizeHexDigest(wire.assembledTextDigest, witness.renderedText.length > 0);

  const conflicts: ReconcileResult[] = [];

  if (opts.trustWireContent && uiDigest !== wireDigest) {
    conflicts.push({ agreement: 'conflict', kind: 'ui_text_differs', detail: { uiDigest, wireDigest } });
  }
  if (wire.order.length > 0 && witness.message.ui_ordering && witness.message.ui_ordering.length > 0) {
    const ui = witness.message.ui_ordering.join(',');
    const w = wire.order.join(',');
    if (ui !== w) conflicts.push({ agreement: 'conflict', kind: 'ui_order_differs', detail: { ui, wire: w } });
  }
  if (witness.message.participants && wire.participantLabels.length > 0) {
    for (const p of witness.message.participants) {
      const label = p.blind_label ?? p.selected_label ?? p.displayed_name;
      if (!label) continue;
      const match = wire.participantLabels.find((x) => x.position === p.position);
      if (match && match.label !== label) {
        conflicts.push({ agreement: 'conflict', kind: 'identity_label_disagreement', detail: { position: p.position, ui: label, wire: match.label } });
      }
    }
  }
  const uiStop = witness.message.stop_error_state ?? 'none';
  if ((witness.stopState && witness.stopState !== uiStop) || (uiStop === 'stopped_by_user' && wire.terminal)) {
    conflicts.push({ agreement: 'conflict', kind: 'ui_stop_state_differs', detail: { uiStop, wireTerminal: wire.terminal, stopState: witness.stopState ?? null } });
  }

  if (conflicts.length === 0) return { agreement: 'full' };
  return conflicts[0]!;
}

/**
 * Rendered text normalization for comparison ONLY (whitespace collapsing);
 * persisted content stays as assembled wire bytes, never the UI projection.
 */
export function normalizeText(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

function normalizeHexDigest(d: string, _hasUi: boolean): string {
  return d.toLowerCase();
}
