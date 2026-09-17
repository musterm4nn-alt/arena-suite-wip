import { z } from 'zod';

/**
 * Zod boundary schemas (plan §17 "schema/ migrations + Zod boundary schemas").
 * Everything entering the service from an untrusted surface (CDP event, witness
 * message, MCP argument, import file) must parse through these first.
 */

export const COMPLETENESS_STATES = [
  'complete',
  'stopped_by_user',
  'failed_transport',
  'partial_stream',
  'observer_gap',
  'reconstructed_ui_only',
  'imported',
  'unknown',
] as const;
export type CompletenessState = (typeof COMPLETENESS_STATES)[number];

export const OBSERVATION_MECHANISMS = [
  'cdp_network', 'cdp_websocket', 'cdp_eventsource', 'cdp_target', 'ui_witness',
  'download', 'import', 'probe', 'diagnostic',
] as const;
export type ObservationMechanism = (typeof OBSERVATION_MECHANISMS)[number];

export const IDENTITY_EVIDENCE_TYPES = [
  'position', 'blind_label', 'selected_label', 'request_catalog_id', 'displayed_name', 'post_vote_reveal',
] as const;
export type IdentityEvidenceType = (typeof IDENTITY_EVIDENCE_TYPES)[number];

export const PART_KINDS = [
  'text', 'reasoning', 'code', 'tool_call', 'tool_result', 'citation',
  'artifact_ref', 'vote', 'ui_state', 'unknown',
] as const;

const safeText = (max = 256 * 1024) => z.string().max(max);
const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.\-]+$/);

/** One routed, account-stamped event entering the shared queue (§6.2). */
export const RoutedEventSchema = z.object({
  account_id: safeId,
  session_epoch_id: safeId.optional(),
  mechanism: z.enum(OBSERVATION_MECHANISMS),
  kind: z.enum([
    'request', 'response_head', 'chunk', 'stream_end', 'ws_frame', 'sse_message',
    'target_info', 'ui_state', 'download', 'import_batch', 'probe_result', 'diagnostic',
  ]),
  target_id: safeId.optional(),
  cdp_session_id: safeId.optional(),
  request_id: safeId.optional(),
  operation_key: safeText(512).optional(),
  observed_at: z.number().int().nonnegative(),
  completeness: z.enum(COMPLETENESS_STATES).default('unknown'),
  payload: z.unknown().optional(),
  note: safeText(4096).optional(),
}).strict();
export type RoutedEvent = z.infer<typeof RoutedEventSchema>;
export type RoutedEventInput = z.input<typeof RoutedEventSchema>;

/** CDP-shaped network event as consumed by capture-core (pre-routing). */
export const CdpNetworkEventSchema = z.object({
  method: z.string(),
  params: z.record(z.unknown()).default({}),
  sessionId: safeId.optional(),
});
export type CdpNetworkEvent = z.infer<typeof CdpNetworkEventSchema>;

/** Isolated-world witness message: UI facts only, no authority (§4, §6.4). */
export const WitnessMessageSchema = z.object({
  v: z.literal(1),
  route: safeText(2048).optional(),
  conversation_ref: safeText(128).optional(),
  participants: z.array(z.object({
    position: z.number().int().min(0).max(8),
    blind_label: safeText(64).optional(),
    selected_label: safeText(128).optional(),
    displayed_name: safeText(128).optional(),
  })).max(8).optional(),
  vote: z.object({ selected_positions: z.array(z.number().int()).max(8), revealed: z.boolean() }).optional(),
  reveal_banner: safeText(512).optional(),
  stop_error_state: z.enum(['none', 'stopped_by_user', 'transport_error', 'unknown']).optional(),
  ui_ordering: z.array(safeId).max(1024).optional(),
}).strict();
export type WitnessMessage = z.infer<typeof WitnessMessageSchema>;

export const AccountScopeSchema = z.union([
  z.object({ account_ids: z.array(safeId).min(1) }),
  z.object({ all: z.literal(true) }),
]);
export type AccountScope = z.infer<typeof AccountScopeSchema>;

export const DirectiveRequestSchema = z.object({
  scope: z.enum(['conversation', 'account', 'archive']),
  conversation_ids: z.array(safeId).max(10_000).default([]),
  account_ids: z.array(safeId).max(64).default([]),
});
export type DirectiveRequest = z.infer<typeof DirectiveRequestSchema>;

export const SyncJobSchema = z.object({
  id: safeId,
  account_id: safeId,
  state: z.enum(['queued', 'running', 'paused', 'completed', 'completed_with_gaps', 'failed', 'cancelled']),
  blocking_reason: z.enum(['auth', 'rate_limit', 'challenge', 'drift', 'account_mismatch', 'owner_action']).optional(),
  run_seq: z.number().int().nonnegative(),
});

export const ProvenanceRefSchema = z.object({
  entity_table: safeId,
  entity_id: safeId,
  field: safeText(64),
  observation_ids: z.array(z.number().int()),
});
