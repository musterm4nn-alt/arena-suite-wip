/**
 * Complete MCP / LLM operation contract per §12
 * Service domains: Accounts, Capture, Sync, Archive, Diagnostics, Analysis, Maintenance
 */

import { z } from "zod";

export const AccountIdOrAllSchema = z.union([z.string().uuid(), z.literal("all")]);

// Accounts
export const AccountsListInputSchema = z.object({});
export const AccountsGetInputSchema = z.object({ account_id: z.string().uuid() });
export const AccountsBeginSigninInputSchema = z.object({ account_id: z.string().uuid().optional() });
export const AccountsIdentityProbeInputSchema = z.object({ account_id: z.string().uuid() });
export const AccountsSetEnabledInputSchema = z.object({ account_id: z.string().uuid(), enabled: z.boolean() });

// Capture
export const CaptureStatusInputSchema = z.object({ account_id: AccountIdOrAllSchema });
export const CapturePauseInputSchema = z.object({ account_id: AccountIdOrAllSchema });
export const CaptureResumeInputSchema = z.object({ account_id: AccountIdOrAllSchema });
export const CaptureStopAllInputSchema = z.object({});
export const CaptureCompletenessInputSchema = z.object({ account_id: z.string().uuid(), conversation_id: z.string().optional() });
export const CaptureRepairInputSchema = z.object({ account_id: z.string().uuid() });

// Sync
export const SyncStartInputSchema = z.object({ account_id: z.string().uuid() });
export const SyncStatusInputSchema = z.object({ job_id: z.string().uuid().optional(), account_id: z.string().uuid().optional() });
export const SyncPauseInputSchema = z.object({ job_id: z.string().uuid() });
export const SyncCancelInputSchema = z.object({ job_id: z.string().uuid() });
export const SyncResumeInputSchema = z.object({ job_id: z.string().uuid() });
export const SyncCoverageInputSchema = z.object({ account_id: z.string().uuid() });
export const SyncVerifyReadInputSchema = z.object({ account_id: z.string().uuid(), operation_key: z.string() });

// Archive
export const ArchiveSearchInputSchema = z.object({
  query: z.string().min(1),
  account_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const ArchiveGetConversationInputSchema = z.object({ conversation_id: z.string(), account_id: z.string().uuid() });
export const ArchiveGetTurnInputSchema = z.object({ turn_id: z.string(), account_id: z.string().uuid() });
export const ArchiveGetProvenanceInputSchema = z.object({ turn_id: z.string(), account_id: z.string().uuid() });
export const ArchiveListBranchesInputSchema = z.object({ conversation_id: z.string(), account_id: z.string().uuid() });
export const ArchiveExportInputSchema = z.object({ account_id: AccountIdOrAllSchema, format: z.enum(["jsonl", "encrypted_bundle"]).default("jsonl") });
export const ArchiveImportInputSchema = z.object({ bundle_path: z.string(), account_id: z.string().uuid().optional() });
export const ArchiveGetArtifactInputSchema = z.object({ artifact_id: z.string().uuid(), account_id: z.string().uuid() });

// Diagnostics
export const DiagnosticsCapabilitiesInputSchema = z.object({});
export const DiagnosticsProtocolCatalogInputSchema = z.object({});
export const DiagnosticsDriftInputSchema = z.object({ account_id: z.string().uuid().optional() });
export const DiagnosticsEvidenceInputSchema = z.object({ account_id: z.string().uuid().optional() });
export const DiagnosticsStorageHealthInputSchema = z.object({});
export const DiagnosticsRecoverInputSchema = z.object({});

// Analysis
export const AnalysisProfilesRunInputSchema = z.object({
  account_id: AccountIdOrAllSchema,
  corpus_hash: z.string().optional(),
  config_version: z.string().optional(),
});
export const AnalysisProfilesGetInputSchema = z.object({ run_id: z.string().uuid() });
export const AnalysisCompareInputSchema = z.object({ run_id_a: z.string().uuid(), run_id_b: z.string().uuid(), metric: z.string() });
export const AnalysisExcerptsInputSchema = z.object({ run_id: z.string().uuid(), metric: z.string(), limit: z.number().default(10) });
export const AnalysisExperimentsInputSchema = z.object({});

// Maintenance
export const MaintenanceBackupInputSchema = z.object({});
export const MaintenanceRestoreInputSchema = z.object({ bundle_path: z.string(), directive_id: z.string().uuid() });
export const MaintenanceLockInputSchema = z.object({});
export const MaintenanceUnlockInputSchema = z.object({ password: z.string().optional() });

export const ToolDefinitions = [
  { name: "accounts_list", domain: "Accounts", input: AccountsListInputSchema, description: "List all local accounts" },
  { name: "accounts_get", domain: "Accounts", input: AccountsGetInputSchema, description: "Get account details" },
  { name: "accounts_begin_signin", domain: "Accounts", input: AccountsBeginSigninInputSchema, description: "Begin sign-in flow for account, owner-driven inside target Arena view" },
  { name: "accounts_identity_probe", domain: "Accounts", input: AccountsIdentityProbeInputSchema, description: "Probe identity for account" },
  { name: "accounts_set_enabled", domain: "Accounts", input: AccountsSetEnabledInputSchema, description: "Enable/disable account" },

  { name: "capture_status", domain: "Capture", input: CaptureStatusInputSchema, description: "Capture status per account" },
  { name: "capture_pause", domain: "Capture", input: CapturePauseInputSchema, description: "Pause capture" },
  { name: "capture_resume", domain: "Capture", input: CaptureResumeInputSchema, description: "Resume capture" },
  { name: "capture_stop_all", domain: "Capture", input: CaptureStopAllInputSchema, description: "Stop all capture" },
  { name: "capture_completeness", domain: "Capture", input: CaptureCompletenessInputSchema, description: "Completeness per conversation" },
  { name: "capture_repair", domain: "Capture", input: CaptureRepairInputSchema, description: "Repair observer gaps" },

  { name: "sync_start", domain: "Sync", input: SyncStartInputSchema, description: "Start sync job" },
  { name: "sync_status", domain: "Sync", input: SyncStatusInputSchema, description: "Sync status" },
  { name: "sync_pause", domain: "Sync", input: SyncPauseInputSchema, description: "Pause sync job" },
  { name: "sync_cancel", domain: "Sync", input: SyncCancelInputSchema, description: "Cancel sync job" },
  { name: "sync_resume", domain: "Sync", input: SyncResumeInputSchema, description: "Resume sync job" },
  { name: "sync_coverage", domain: "Sync", input: SyncCoverageInputSchema, description: "Coverage report per §9.3" },
  { name: "sync_verify_read", domain: "Sync", input: SyncVerifyReadInputSchema, description: "Verify read qualification probe" },

  { name: "archive_search", domain: "Archive", input: ArchiveSearchInputSchema, description: "Search archive, cursor pagination, opaque identifiers" },
  { name: "archive_get_conversation", domain: "Archive", input: ArchiveGetConversationInputSchema, description: "Get conversation" },
  { name: "archive_get_turn", domain: "Archive", input: ArchiveGetTurnInputSchema, description: "Get turn" },
  { name: "archive_get_provenance", domain: "Archive", input: ArchiveGetProvenanceInputSchema, description: "Get provenance for turn" },
  { name: "archive_list_branches", domain: "Archive", input: ArchiveListBranchesInputSchema, description: "List branches" },
  { name: "archive_export", domain: "Archive", input: ArchiveExportInputSchema, description: "Export" },
  { name: "archive_import", domain: "Archive", input: ArchiveImportInputSchema, description: "Import" },
  { name: "archive_get_artifact", domain: "Archive", input: ArchiveGetArtifactInputSchema, description: "Get artifact" },

  { name: "diagnostics_capabilities", domain: "Diagnostics", input: DiagnosticsCapabilitiesInputSchema, description: "Recommended first call, explains unavailable/degraded features" },
  { name: "diagnostics_protocol_catalog", domain: "Diagnostics", input: DiagnosticsProtocolCatalogInputSchema, description: "Protocol catalog" },
  { name: "diagnostics_drift", domain: "Diagnostics", input: DiagnosticsDriftInputSchema, description: "Drift events" },
  { name: "diagnostics_evidence", domain: "Diagnostics", input: DiagnosticsEvidenceInputSchema, description: "Evidence register" },
  { name: "diagnostics_storage_health", domain: "Diagnostics", input: DiagnosticsStorageHealthInputSchema, description: "Storage health" },
  { name: "diagnostics_recover", domain: "Diagnostics", input: DiagnosticsRecoverInputSchema, description: "Recover" },

  { name: "analysis_profiles_run", domain: "Analysis", input: AnalysisProfilesRunInputSchema, description: "Run deterministic profiles" },
  { name: "analysis_profiles_get", domain: "Analysis", input: AnalysisProfilesGetInputSchema, description: "Get analysis profiles" },
  { name: "analysis_compare", domain: "Analysis", input: AnalysisCompareInputSchema, description: "Compare analysis runs" },
  { name: "analysis_excerpts", domain: "Analysis", input: AnalysisExcerptsInputSchema, description: "Representative excerpts, deterministic, link back to provenance" },
  { name: "analysis_experiments", domain: "Analysis", input: AnalysisExperimentsInputSchema, description: "Experiment namespace, never mutates observed identity" },

  { name: "maintenance_backup", domain: "Maintenance", input: MaintenanceBackupInputSchema, description: "Encrypted bundle + manifest, verification by reopening" },
  { name: "maintenance_restore", domain: "Maintenance", input: MaintenanceRestoreInputSchema, description: "Destructive, requires directive, only with capture/sync stopped" },
  { name: "maintenance_lock", domain: "Maintenance", input: MaintenanceLockInputSchema, description: "Lock archive" },
  { name: "maintenance_unlock", domain: "Maintenance", input: MaintenanceUnlockInputSchema, description: "Unlock archive" },
] as const;

export const TypedErrors = [
  "E_SCOPE_MISMATCH",
  "E_AUTH_EXPIRED",
  "E_OWNER_ACTION_REQUIRED",
  "E_RATE_LIMITED",
  "E_CONFIRM_REQUIRED",
  "E_LOCKED",
  "E_DRIFT",
  "E_UNSUPPORTED",
  "E_PARTIAL",
  "E_BUSY",
] as const;

export type TypedError = typeof TypedErrors[number];
