import { z } from "zod";

// Core identity
export const AccountIdSchema = z.string().uuid();
export type AccountId = z.infer<typeof AccountIdSchema>;

export const SessionEpochIdSchema = z.string().uuid();
export type SessionEpochId = z.infer<typeof SessionEpochIdSchema>;

export const ConversationIdSchema = z.string().min(1);
export type ConversationId = z.infer<typeof ConversationIdSchema>;

export const BranchIdSchema = z.string().min(1);
export type BranchId = z.infer<typeof BranchIdSchema>;

export const TurnIdSchema = z.string().min(1);
export type TurnId = z.infer<typeof TurnIdSchema>;

// Completeness states per plan §7
export const CompletenessStateSchema = z.enum([
  "complete",
  "stopped_by_user",
  "failed_transport",
  "partial_stream",
  "observer_gap",
  "reconstructed_ui_only",
  "imported",
  "unknown",
]);
export type CompletenessState = z.infer<typeof CompletenessStateSchema>;

// Observation mechanism
export const ObservationMechanismSchema = z.enum([
  "cdp_network",
  "cdp_target_lifecycle",
  "isolated_world_witness",
  "download_manager",
  "import_adapter",
  "sync_probe",
]);
export type ObservationMechanism = z.infer<typeof ObservationMechanismSchema>;

// Protocol operation
export const TransportSchema = z.enum([
  "json",
  "chunked",
  "sse",
  "websocket",
  "download",
  "rsc",
  "unknown",
]);
export type Transport = z.infer<typeof TransportSchema>;

export const DirectionSchema = z.enum([
  "read",
  "mutate",
  "asset",
  "auth",
  "config",
  "unknown",
]);
export type Direction = z.infer<typeof DirectionSchema>;

export const EvidenceStateSchema = z.enum([
  "seen",
  "classified",
  "adapter_ready",
  "owner_verified_read",
  "deprecated",
]);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

export const ProtocolOpSchema = z.object({
  id: z.string().min(1),
  host_class: z.string().min(1),
  method: z.string().min(1),
  path_template: z.string().min(1),
  transport: TransportSchema,
  direction: DirectionSchema,
  evidence_state: EvidenceStateSchema,
  account_binding_evidence: z.string().optional(),
  payload_family: z.string().min(1),
  shape_hash: z.string().min(1),
  adapter_id: z.string().min(1),
  adapter_version: z.string().min(1),
  completeness_model: z.string().optional(),
  first_seen: z.string().datetime(),
  last_seen: z.string().datetime(),
  drift_counters: z.record(z.number()).default({}),
});
export type ProtocolOp = z.infer<typeof ProtocolOpSchema>;

// Observation journal
export const ObservationSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  session_epoch_id: SessionEpochIdSchema,
  mechanism: ObservationMechanismSchema,
  target_id: z.string().optional(),
  session_id: z.string().optional(), // CDP sessionId
  operation_key: z.string().optional(),
  adapter_id: z.string().optional(),
  adapter_version: z.string().optional(),
  observed_at: z.string().datetime(),
  completeness_state: CompletenessStateSchema.optional(),
  sanitized_evidence_ref: z.string().optional(), // pointer to blob or inline sanitized JSON
  byte_length: z.number().int().nonnegative().optional(),
  shape_hash: z.string().optional(),
  provenance_chain: z.array(z.string()).optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// Turn part
export const TurnPartSchema = z.object({
  id: z.string().min(1),
  turn_id: TurnIdSchema,
  index: z.number().int().nonnegative(),
  type: z.enum(["text", "code", "citation", "tool_call", "tool_result", "image_ref", "artifact_ref", "reasoning"]),
  text: z.string().optional(),
  mime: z.string().optional(),
  artifact_id: z.string().optional(),
  provenance_observation_ids: z.array(z.string()),
});
export type TurnPart = z.infer<typeof TurnPartSchema>;

// Turn
export const TurnSchema = z.object({
  id: TurnIdSchema,
  conversation_id: ConversationIdSchema,
  branch_id: BranchIdSchema,
  account_id: AccountIdSchema,
  role: z.enum(["user", "assistant", "system", "tool"]),
  completeness: CompletenessStateSchema,
  created_at: z.string().datetime(),
  parts: z.array(TurnPartSchema).default([]),
  participant_position: z.number().int().optional(),
  blind_label: z.string().optional(),
  selected_label: z.string().optional(),
  revealed_identity: z.string().optional(), // never mutated from style inference, only observed
  stop_reason: z.string().optional(),
  provenance: z.object({
    observation_ids: z.array(z.string()),
    adapter_version: z.string().optional(),
    assembled_hash: z.string().optional(),
  }),
});
export type Turn = z.infer<typeof TurnSchema>;

// Conversation
export const ConversationSchema = z.object({
  id: ConversationIdSchema,
  account_id: AccountIdSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  title: z.string().optional(),
  branch_ids: z.array(BranchIdSchema).default([]),
});
export type Conversation = z.infer<typeof ConversationSchema>;

// Sync job
export const SyncJobStateSchema = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "completed_with_gaps",
  "failed",
  "cancelled",
]);
export type SyncJobState = z.infer<typeof SyncJobStateSchema>;

export const SyncCheckpointSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  account_id: AccountIdSchema,
  cursor: z.string().optional(),
  page_fingerprint: z.string().optional(),
  seen_set_digest: z.string().optional(),
  counts: z.record(z.number()).default({}),
  adapter_version: z.string(),
  run_sequence: z.number().int().nonnegative(),
  committed_at: z.string().datetime(),
});
export type SyncCheckpoint = z.infer<typeof SyncCheckpointSchema>;

// Artifact
export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  conversation_id: ConversationIdSchema.optional(),
  source_url_safe_ref: z.object({
    host: z.string(),
    path: z.string(),
    query_key_set: z.array(z.string()),
    query_hash: z.string(),
    expiry_class: z.string(),
  }).optional(),
  mime: z.string(),
  byte_length: z.number().int().nonnegative(),
  content_hash: z.string(),
  sealed_blob_path: z.string(),
  created_at: z.string().datetime(),
  provenance_observation_ids: z.array(z.string()),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// Delete directive
export const DeleteScopeSchema = z.enum(["conversation", "account", "archive"]);
export type DeleteScope = z.infer<typeof DeleteScopeSchema>;

export const DeleteDirectiveSchema = z.object({
  id: z.string().uuid(),
  scope: DeleteScopeSchema,
  account_id: AccountIdSchema.optional(),
  conversation_ids: z.array(ConversationIdSchema).optional(),
  canonical_scope_hash: z.string(),
  count: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  nonce: z.string(),
  used: z.boolean().default(false),
});
export type DeleteDirective = z.infer<typeof DeleteDirectiveSchema>;

// Coverage report §9.3
export const CoverageReportSchema = z.object({
  account_id: AccountIdSchema,
  listing_method: z.string(),
  listing_verified_at: z.string().datetime(),
  newest_seen: z.string().datetime().optional(),
  oldest_seen: z.string().datetime().optional(),
  items_known: z.number().int().nonnegative(),
  items_archived: z.number().int().nonnegative(),
  items_complete: z.number().int().nonnegative(),
  items_partial: z.number().int().nonnegative(),
  items_unknown_content: z.number().int().nonnegative(),
  detail_failures: z.number().int().nonnegative(),
  pagination_gaps: z.array(z.object({ cursor: z.string().optional(), reason: z.string() })).default([]),
  ownership_conflicts: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
  adapter_gaps: z.array(z.object({ adapter_id: z.string(), reason: z.string() })).default([]),
  last_run: z.string().datetime(),
  confidence_statement: z.string(),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

// Stream assembly ledger §6.3
export const StreamAssemblyRecordSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  session_epoch_id: SessionEpochIdSchema,
  request_id: z.string(),
  url_safe_ref: z.object({
    host: z.string(),
    path: z.string(),
    query_key_set: z.array(z.string()),
    query_hash: z.string(),
    expiry_class: z.string(),
  }),
  monotonic_chunk_seq: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
  content_hash: z.string(),
  duplicate_count: z.number().int().nonnegative().default(0),
  first_ts: z.string().datetime(),
  last_ts: z.string().datetime(),
  expected_content_length: z.number().int().nonnegative().optional(),
  transport_terminal_signal: z.string().optional(),
  parser_terminal_signal: z.string().optional(),
  target_provenance: z.object({
    target_id: z.string().optional(),
    session_id: z.string().optional(),
  }),
  gap_intervals: z.array(z.object({ start_seq: z.number(), end_seq: z.number(), reason: z.string() })).default([]),
});
export type StreamAssemblyRecord = z.infer<typeof StreamAssemblyRecordSchema>;

// Witness observation (isolated-world)
export const WitnessObservationSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  session_epoch_id: SessionEpochIdSchema,
  observed_at: z.string().datetime(),
  route: z.string().optional(),
  conversation_ref: z.string().optional(),
  participant_positions: z.array(z.number()).optional(),
  blind_labels: z.array(z.string()).optional(),
  selected_labels: z.array(z.string()).optional(),
  vote_state: z.string().optional(),
  reveal_banner: z.string().optional(),
  stop_error_state: z.string().optional(),
  ui_ordering: z.array(z.string()).optional(),
  selector_version: z.string(),
  drift_counter: z.number().int().nonnegative().default(0),
});
export type WitnessObservation = z.infer<typeof WitnessObservationSchema>;
