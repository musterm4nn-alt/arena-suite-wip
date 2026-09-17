import { z } from 'zod';

/**
 * Non-negotiable: Unknown remains unknown. Every enum includes unknown.
 * Account scope is part of identity — every observation keyed by account_id + session_epoch.
 */

// --- Identity & Accounts ---

export const AccountIdSchema = z.string().uuid().brand<'AccountId'>();
export type AccountId = z.infer<typeof AccountIdSchema>;

export const SessionEpochIdSchema = z.string().uuid().brand<'SessionEpochId'>();
export type SessionEpochId = z.infer<typeof SessionEpochIdSchema>;

export const AccountSchema = z.object({
  id: AccountIdSchema,
  display_name: z.string().nullable(),
  email_hint: z.string().nullable(), // never email itself, only hint
  partition_path: z.string(), // app-controlled path, never derived from email
  created_at: z.string().datetime(),
  last_seen_at: z.string().datetime().nullable(),
  enabled: z.boolean().default(true),
  auth_state: z.enum(['signed_out', 'signed_in', 'challenge', 'expired', 'owner_action_required', 'unknown']).default('unknown'),
  session_epoch_id: SessionEpochIdSchema.nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const SessionEpochSchema = z.object({
  id: SessionEpochIdSchema,
  account_id: AccountIdSchema,
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  end_reason: z.enum(['sign_out', 'identity_mismatch', 'credential_invalid', 'app_restart', 'unknown']).nullable(),
});
export type SessionEpoch = z.infer<typeof SessionEpochSchema>;

// --- Observations (append-only, encrypted DB) ---

export const ObservationMechanismSchema = z.enum([
  'cdp_network',
  'cdp_target_lifecycle',
  'isolated_world_witness',
  'download_manager',
  'sync_replay',
  'import',
  'unknown'
]);

export const ObservationSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  session_epoch_id: SessionEpochIdSchema.nullable(),
  mechanism: ObservationMechanismSchema,
  target_id: z.string().nullable(),
  session_id: z.string().nullable(), // CDP sessionId
  operation_key: z.string().nullable(), // protocol_op id
  observed_at: z.string().datetime(),
  completeness_state: z.enum(['complete', 'partial_stream', 'observer_gap', 'reconstructed_ui_only', 'unknown']),
  sanitized_evidence_ref: z.string().nullable(), // pointer to blob or inline sanitized JSON
  adapter_id: z.string().nullable(),
  adapter_version: z.string().nullable(),
  byte_length: z.number().int().nonnegative().nullable(),
  shape_hash: z.string().nullable(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// --- Conversations / Branches / Turns ---

export const ConversationIdSchema = z.string().brand<'ConversationId'>();
export type ConversationId = z.infer<typeof ConversationIdSchema>;

export const BranchIdSchema = z.string().brand<'BranchId'>();
export type BranchId = z.infer<typeof BranchIdSchema>;

export const TurnIdSchema = z.string().brand<'TurnId'>();
export type TurnId = z.infer<typeof TurnIdSchema>;

export const TurnRoleSchema = z.enum(['user', 'assistant', 'system', 'tool', 'unknown']);
export const CompletenessStateSchema = z.enum([
  'complete',
  'stopped_by_user',
  'failed_transport',
  'partial_stream',
  'observer_gap',
  'reconstructed_ui_only',
  'imported',
  'unknown'
]);

export const ConversationSchema = z.object({
  id: ConversationIdSchema,
  account_id: AccountIdSchema,
  arena_conversation_id: z.string().nullable(), // observed remote ID, not trusted as primary key
  title: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  provenance_observation_ids: z.array(z.string().uuid()),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const BranchSchema = z.object({
  id: BranchIdSchema,
  conversation_id: ConversationIdSchema,
  parent_branch_id: BranchIdSchema.nullable(),
  revision_number: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  trigger: z.enum(['regeneration', 'retry', 'edit', 'initial', 'import', 'unknown']),
});
export type Branch = z.infer<typeof BranchSchema>;

export const TurnSchema = z.object({
  id: TurnIdSchema,
  branch_id: BranchIdSchema,
  conversation_id: ConversationIdSchema,
  account_id: AccountIdSchema,
  role: TurnRoleSchema,
  position: z.number().int().nonnegative(),
  completeness: CompletenessStateSchema,
  created_at: z.string().datetime(),
  model_identity_claim_id: z.string().uuid().nullable(),
  observation_ids: z.array(z.string().uuid()),
});
export type Turn = z.infer<typeof TurnSchema>;

export const PartSchema = z.object({
  id: z.string().uuid(),
  turn_id: TurnIdSchema,
  account_id: AccountIdSchema,
  position: z.number().int().nonnegative(),
  type: z.enum(['text', 'code', 'citation', 'tool_call', 'tool_result', 'image_ref', 'artifact_ref', 'unknown']),
  text: z.string().nullable(),
  artifact_id: z.string().uuid().nullable(),
  tool_name: z.string().nullable(),
  provenance_observation_id: z.string().uuid().nullable(),
});
export type Part = z.infer<typeof PartSchema>;

// --- Model Identity (append-only claims, resolved view separately) ---

export const IdentityClaimSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  conversation_id: ConversationIdSchema.nullable(),
  branch_id: BranchIdSchema.nullable(),
  turn_id: TurnIdSchema.nullable(),
  turn_range_start: z.number().int().nullable(),
  turn_range_end: z.number().int().nullable(),
  claim_type: z.enum(['participant_position', 'blind_label', 'selected_label', 'request_id', 'displayed_name', 'reveal', 'catalog_id', 'unknown']),
  value: z.string(),
  evidence_mechanism: ObservationMechanismSchema,
  observed_at: z.string().datetime(),
  observation_id: z.string().uuid(),
});
export type IdentityClaim = z.infer<typeof IdentityClaimSchema>;

// --- Artifacts ---

export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  conversation_id: ConversationIdSchema.nullable(),
  turn_id: TurnIdSchema.nullable(),
  source_url_safe_ref: z.string().nullable(), // SafeUrlRef JSON
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  byte_length: z.number().int().nonnegative(),
  sha256: z.string(),
  sealed_blob_path: z.string(), // path to encrypted blob
  staging_cleanup_verified: z.boolean().default(false),
  created_at: z.string().datetime(),
  derived_from_artifact_id: z.string().uuid().nullable(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// --- Protocol Catalog ---

export const ProtocolOpSchema = z.object({
  id: z.string(),
  host_class: z.string(),
  method: z.string(),
  path_template: z.string(),
  transport: z.enum(['json', 'chunked', 'sse', 'websocket', 'download', 'rsc', 'unknown']),
  direction: z.enum(['read', 'mutate', 'asset', 'auth', 'config', 'unknown']),
  evidence_state: z.enum(['seen', 'classified', 'adapter_ready', 'owner_verified_read', 'deprecated']),
  account_binding_evidence: z.enum(['partition_verified', 'inferred', 'unknown']),
  payload_family: z.string().nullable(),
  shape_hash: z.string().nullable(),
  adapter_id: z.string().nullable(),
  adapter_version: z.string().nullable(),
  completeness_model: z.string().nullable(),
  first_seen: z.string().datetime(),
  last_seen: z.string().datetime(),
  drift_counters: z.record(z.number().int()),
});
export type ProtocolOp = z.infer<typeof ProtocolOpSchema>;

// --- Sync ---

export const SyncJobStateSchema = z.enum(['queued', 'running', 'paused', 'completed', 'completed_with_gaps', 'failed', 'cancelled']);
export const SyncJobSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  state: SyncJobStateSchema,
  listing_method: z.enum(['api_replay', 'ui_traversal', 'import', 'unknown']),
  checkpoint: z.object({
    cursor: z.string().nullable(),
    page_fingerprint: z.string().nullable(),
    seen_set_digest: z.string().nullable(),
    counts: z.record(z.number().int()),
    adapter_version: z.string().nullable(),
    run_sequence: z.number().int(),
  }).nullable(),
  blocking_reason: z.enum(['auth', 'rate_limit', 'challenge', 'drift', 'account_mismatch', 'none']).default('none'),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type SyncJob = z.infer<typeof SyncJobSchema>;

export const CoverageReportSchema = z.object({
  account_id: AccountIdSchema,
  listing_method: z.string(),
  listing_verified_at: z.string().datetime().nullable(),
  newest_seen: z.string().datetime().nullable(),
  oldest_seen: z.string().datetime().nullable(),
  items_known: z.number().int().nonnegative(),
  items_archived: z.number().int().nonnegative(),
  items_complete: z.number().int().nonnegative(),
  items_partial: z.number().int().nonnegative(),
  items_unknown_content: z.number().int().nonnegative(),
  detail_failures: z.number().int().nonnegative(),
  pagination_gaps: z.array(z.object({ cursor: z.string().nullable(), reason: z.string() })),
  ownership_conflicts: z.array(z.object({ conversation_id: z.string(), reason: z.string() })),
  adapter_gaps: z.array(z.object({ operation_id: z.string(), reason: z.string() })),
  last_run: z.string().datetime().nullable(),
  confidence_statement: z.string(),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

// --- Deletion / Directives ---

export const DirectiveScopeSchema = z.enum(['conversation', 'account', 'archive']);
export const DirectiveSchema = z.object({
  id: z.string().uuid(),
  scope: DirectiveScopeSchema,
  account_id: AccountIdSchema.nullable(),
  conversation_ids: z.array(ConversationIdSchema),
  count: z.number().int().nonnegative(),
  canonical_scope_hash: z.string(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  nonce: z.string(),
  used: z.boolean().default(false),
});
export type Directive = z.infer<typeof DirectiveSchema>;

// --- Analysis ---

export const AnalysisRunSchema = z.object({
  id: z.string().uuid(),
  corpus_hash: z.string(),
  adapter_versions: z.record(z.string()),
  code_version: z.string(),
  config: z.record(z.unknown()),
  created_at: z.string().datetime(),
  cohort_definition: z.object({
    completeness: z.array(CompletenessStateSchema),
    identity_evidence: z.enum(['observed', 'revealed', 'any', 'unknown']),
    account_ids: z.array(AccountIdSchema).nullable(),
  }),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;
