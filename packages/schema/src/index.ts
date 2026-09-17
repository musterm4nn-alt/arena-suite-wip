/**
 * @arena/schema — Zod boundary schemas shared by all packages.
 *
 * Every value crossing a process boundary (CDP -> main -> archive service ->
 * MCP) or a persistence boundary (SQLite, sealed blobs, exports) is validated
 * against one of these schemas. Unknowns are explicit variants, never null
 * punning or guessed defaults (plan §2 rule 1).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Stable local account UUID. Never derived from page data. */
export const AccountIdSchema = z.string().uuid().brand<"AccountId">();
export type AccountId = z.infer<typeof AccountIdSchema>;

/** Session epoch: started by each successful sign-in, ended by sign-out / identity mismatch. */
export const SessionEpochIdSchema = z.string().uuid().brand<"SessionEpochId">();
export type SessionEpochId = z.infer<typeof SessionEpochIdSchema>;

/** Opaque cursor for paginated archive reads. */
export const CursorSchema = z.string().min(1).brand<"Cursor">();
export type Cursor = z.infer<typeof CursorSchema>;

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

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

export const ObservationMechanismSchema = z.enum([
  "cdp-network", // passive Network.* events
  "cdp-target", // target lifecycle evidence
  "isolated-witness", // read-only isolated-world DOM witness
  "diagnostic-probe", // owner-session / gated diagnostic experiment
  "import", // ingested from export or prior archive
  "unknown",
]);
export type ObservationMechanism = z.infer<typeof ObservationMechanismSchema>;

/** Turn completeness — plan §7. `complete` requires positive terminal evidence. */
export const CompletenessSchema = z.enum([
  "complete",
  "stopped_by_user",
  "failed_transport",
  "partial_stream",
  "observer_gap",
  "reconstructed_ui_only",
  "imported",
  "unknown",
]);
export type Completeness = z.infer<typeof CompletenessSchema>;

export const TerminalSignalSchema = z.enum([
  "stream_end_marker", // parser saw a valid terminal record
  "response_close", // transport closed cleanly after terminal record
  "transport_close", // transport closed (terminal record status tracked separately)
  "loading_finished", // CDP loadingFinished
  "loading_failed", // CDP loadingFailed
  "target_destroyed", // target went away mid-stream
  "user_stop", // stop/abort evidence
  "evicted", // observer buffer evicted before terminal
  "unknown",
]);
export type TerminalSignal = z.infer<typeof TerminalSignalSchema>;

// ---------------------------------------------------------------------------
// Observations (append-only journal rows)
// ---------------------------------------------------------------------------

export const ObservationSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  session_epoch_id: SessionEpochIdSchema.nullable(),
  mechanism: ObservationMechanismSchema,
  /** CDP session/target provenance; absent for imports. */
  target_id: z.string().min(1).nullable(),
  cdp_session_id: z.string().min(1).nullable(),
  /** Key into protocol catalog, e.g. "POST /api/stream". Unknown stays unknown. */
  operation_key: z.string().min(1),
  adapter_id: z.string().min(1).nullable(),
  adapter_version: z.string().min(1).nullable(),
  observed_at_ms: z.number().int().nonnegative(),
  completeness: CompletenessSchema,
  /** Sanitized evidence reference (row id, blob id, or safe ref) — never raw secrets. */
  evidence_ref: z.string().min(1).nullable(),
  /** True when the observer knows it was absent/evicted during this observation. */
  observer_gap: z.boolean(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// ---------------------------------------------------------------------------
// Protocol catalog — plan §8
// ---------------------------------------------------------------------------

export const ProtocolDirectionSchema = z.enum([
  "read",
  "mutate",
  "asset",
  "auth",
  "config",
  "unknown",
]);
export type ProtocolDirection = z.infer<typeof ProtocolDirectionSchema>;

export const EvidenceStateSchema = z.enum([
  "seen",
  "classified",
  "adapter_ready",
  "owner_verified_read",
  "deprecated",
]);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

export const ProtocolOpSchema = z.object({
  id: z.string().uuid(),
  host_class: z.string().min(1),
  method: z.string().min(1),
  /** Path with identifiers masked, e.g. "/api/c/:id/stream". */
  path_template: z.string().min(1),
  transport: TransportSchema,
  direction: ProtocolDirectionSchema,
  evidence_state: EvidenceStateSchema,
  account_binding_evidence: z.string().nullable(),
  payload_family: z.string().nullable(),
  shape_hash: z.string().nullable(),
  adapter_id: z.string().nullable(),
  adapter_version: z.string().nullable(),
  /** How completeness is determined for this op; null = unknown. */
  completeness_model: z.string().nullable(),
  first_seen_ms: z.number().int().nonnegative(),
  last_seen_ms: z.number().int().nonnegative(),
  drift_counters: z.record(z.string(), z.number().int().nonnegative()),
});
export type ProtocolOp = z.infer<typeof ProtocolOpSchema>;

// ---------------------------------------------------------------------------
// Sync — plan §9
// ---------------------------------------------------------------------------

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

export const SyncBlockingReasonSchema = z.enum([
  "auth",
  "rate_limit",
  "challenge",
  "drift",
  "account_mismatch",
  "owner_action_required",
  "none",
]);
export type SyncBlockingReason = z.infer<typeof SyncBlockingReasonSchema>;

export const SyncCheckpointSchema = z.object({
  job_id: z.string().uuid(),
  account_id: AccountIdSchema,
  /** Last fully committed page/cursor. */
  cursor: z.string().nullable(),
  page_fingerprint: z.string().nullable(),
  seen_set_digest: z.string().nullable(),
  items_committed: z.number().int().nonnegative(),
  adapter_id: z.string().nullable(),
  adapter_version: z.string().nullable(),
  run_sequence: z.number().int().nonnegative(),
  committed_at_ms: z.number().int().nonnegative(),
});
export type SyncCheckpoint = z.infer<typeof SyncCheckpointSchema>;

export const CoverageReportSchema = z.object({
  account_id: AccountIdSchema,
  listing_method: z.string().min(1),
  listing_verified_at_ms: z.number().int().nonnegative().nullable(),
  newest_seen: z.string().nullable(),
  oldest_seen: z.string().nullable(),
  items_known: z.number().int().nonnegative(),
  items_archived: z.number().int().nonnegative(),
  items_complete: z.number().int().nonnegative(),
  items_partial: z.number().int().nonnegative(),
  items_unknown_content: z.number().int().nonnegative(),
  detail_failures: z.number().int().nonnegative(),
  pagination_gaps: z.array(z.string()),
  ownership_conflicts: z.array(z.string()),
  adapter_gaps: z.array(z.string()),
  last_run_ms: z.number().int().nonnegative().nullable(),
  confidence_statement: z.string().min(1),
});
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

// ---------------------------------------------------------------------------
// Model identity — plan §10.1 (append-only claims; resolved identity is a view)
// ---------------------------------------------------------------------------

export const IdentityEvidenceTypeSchema = z.enum([
  "participant_position", // left/right, A/B
  "blind_label", // pre-vote label shown in UI
  "selected_label", // label selected by owner in direct mode
  "request_identifier", // catalog/request id observed on the wire
  "displayed_name", // provider/model name rendered in UI
  "post_vote_reveal", // name revealed after voting
  "unknown",
]);
export type IdentityEvidenceType = z.infer<typeof IdentityEvidenceTypeSchema>;

export const IdentityClaimSchema = z.object({
  id: z.string().uuid(),
  account_id: AccountIdSchema,
  participant_id: z.string().uuid(),
  evidence_type: IdentityEvidenceTypeSchema,
  /** Raw observed value (sanitized). Semantics unknown unless a reveal binds it. */
  value: z.string().min(1),
  observation_id: z.string().uuid(),
  observed_at_ms: z.number().int().nonnegative(),
  /** Smallest supported scope; null bounds mean unbounded-but-explicit. */
  turn_range_start: z.number().int().nonnegative().nullable(),
  turn_range_end: z.number().int().nonnegative().nullable(),
});
export type IdentityClaim = z.infer<typeof IdentityClaimSchema>;

// ---------------------------------------------------------------------------
// Maintenance / directives
// ---------------------------------------------------------------------------

export const DirectiveScopeSchema = z.union([
  z.object({ kind: z.literal("conversation"), accountId: z.string().uuid(), conversationId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("account"), accountId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("archive") }).strict(),
  z.object({ kind: z.literal("restore") }).strict(),
]);
export type DirectiveScope = z.infer<typeof DirectiveScopeSchema>;
