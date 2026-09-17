/**
 * Drift events are explicit. Shape-hash changes, missing terminal markers, unknown fields,
 * unexpected status changes and UI/network disagreement create structured records.
 */

export interface DriftEvent {
  id: string;
  operation_id: string;
  type: 'shape_change' | 'missing_terminal' | 'unknown_field' | 'status_change' | 'ui_network_mismatch' | 'unknown';
  observed_at: string;
  previous_shape_hash: string | null;
  new_shape_hash: string | null;
  details: Record<string, unknown>;
  adapter_id: string | null;
  adapter_version: string | null;
}

export class DriftDetector {
  private events: DriftEvent[] = [];

  detectShapeChange(opId: string, prevHash: string | null, newHash: string | null, adapterId?: string | null): DriftEvent | null {
    if (!prevHash || !newHash) return null;
    if (prevHash === newHash) return null;
    const ev: DriftEvent = {
      id: `${opId}-${Date.now()}`,
      operation_id: opId,
      type: 'shape_change',
      observed_at: new Date().toISOString(),
      previous_shape_hash: prevHash,
      new_shape_hash: newHash,
      details: { prevHash, newHash },
      adapter_id: adapterId ?? null,
      adapter_version: null,
    };
    this.events.push(ev);
    return ev;
  }

  detectMissingTerminal(opId: string, expected: string, got: string | null): DriftEvent | null {
    if (got === expected) return null;
    const ev: DriftEvent = {
      id: `${opId}-${Date.now()}`,
      operation_id: opId,
      type: 'missing_terminal',
      observed_at: new Date().toISOString(),
      previous_shape_hash: null,
      new_shape_hash: null,
      details: { expected, got },
      adapter_id: null,
      adapter_version: null,
    };
    this.events.push(ev);
    return ev;
  }

  detectUiNetworkMismatch(opId: string, uiEvidence: unknown, networkEvidence: unknown): DriftEvent {
    const ev: DriftEvent = {
      id: `${opId}-${Date.now()}`,
      operation_id: opId,
      type: 'ui_network_mismatch',
      observed_at: new Date().toISOString(),
      previous_shape_hash: null,
      new_shape_hash: null,
      details: { uiEvidence, networkEvidence },
      adapter_id: null,
      adapter_version: null,
    };
    this.events.push(ev);
    return ev;
  }

  list(): DriftEvent[] {
    return this.events.slice().sort((a, b) => b.observed_at.localeCompare(a.observed_at));
  }

  clear(): void {
    this.events = [];
  }
}
