export type Transport = 'json' | 'chunked' | 'sse' | 'websocket' | 'download' | 'rsc' | 'unknown';
export type Direction = 'read' | 'mutate' | 'asset' | 'auth' | 'config' | 'unknown';
export type EvidenceState = 'seen' | 'classified' | 'adapter_ready' | 'owner_verified_read' | 'deprecated';

export interface ProtocolOp {
  id: string;
  host_class: string;
  method: string;
  path_template: string;
  transport: Transport;
  direction: Direction;
  evidence_state: EvidenceState;
  account_binding_evidence: 'partition_verified' | 'inferred' | 'unknown';
  payload_family: string | null;
  shape_hash: string | null;
  adapter_id: string | null;
  adapter_version: string | null;
  completeness_model: string | null;
  first_seen: string;
  last_seen: string;
  drift_counters: Record<string, number>;
}
