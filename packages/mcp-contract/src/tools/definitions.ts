import { z } from 'zod';

/**
 * Complete MCP / LLM operation contract per section 12
 * Default transport: stdio bridge → Unix domain socket 0600
 * Optional Streamable HTTP on 127.0.0.1 with ephemeral port, bearer token, Host/Origin validation, no CORS, block Arena sessions from loopback
 */

export const AccountIdSchema = z.string().uuid();
export const ConversationIdSchema = z.string();
export const TurnIdSchema = z.string();

// --- Accounts ---
export const accounts_list = {
  name: 'accounts_list',
  description: 'List all local accounts with auth state',
  inputSchema: z.object({}),
  outputSchema: z.object({
    accounts: z.array(z.object({
      id: AccountIdSchema,
      display_name: z.string().nullable(),
      auth_state: z.string(),
      enabled: z.boolean(),
    })),
  }),
};

export const accounts_get = {
  name: 'accounts_get',
  description: 'Get account details',
  inputSchema: z.object({ account_id: AccountIdSchema }),
};

export const accounts_begin_signin = {
  name: 'accounts_begin_signin',
  description: 'Begin owner-driven sign-in inside target Arena view',
  inputSchema: z.object({ account_id: AccountIdSchema }),
};

export const accounts_identity_probe = {
  name: 'accounts_identity_probe',
  description: 'Probe identity for account — establishes session epoch ownership',
  inputSchema: z.object({ account_id: AccountIdSchema }),
};

export const accounts_set_enabled = {
  name: 'accounts_set_enabled',
  description: 'Enable/disable account — one account failing must not degrade another',
  inputSchema: z.object({ account_id: AccountIdSchema, enabled: z.boolean() }),
};

// --- Capture ---
export const capture_status = {
  name: 'capture_status',
  description: 'Get capture status per account',
  inputSchema: z.object({ account_id: AccountIdSchema.optional(), all: z.boolean().optional() }),
};

export const capture_pause = {
  name: 'capture_pause',
  description: 'Pause capture for account',
  inputSchema: z.object({ account_id: AccountIdSchema }),
};

export const capture_resume = {
  name: 'capture_resume',
  inputSchema: z.object({ account_id: AccountIdSchema }),
};

export const capture_stop_all = {
  name: 'capture_stop_all',
  inputSchema: z.object({ reason: z.string() }),
};

export const capture_completeness = {
  name: 'capture_completeness',
  description: 'Get completeness model for conversation/turn',
  inputSchema: z.object({ conversation_id: ConversationIdSchema.optional(), turn_id: TurnIdSchema.optional() }),
};

export const capture_repair = {
  name: 'capture_repair',
  description: 'Attempt repair of observer_gap',
  inputSchema: z.object({ account_id: AccountIdSchema, conversation_id: ConversationIdSchema.optional() }),
};

// --- Sync ---
export const sync_start = {
  name: 'sync_start',
  description: 'Start sync job — requires qualified read',
  inputSchema: z.object({ account_id: AccountIdSchema, method: z.enum(['api_replay', 'ui_traversal']).optional() }),
};

export const sync_status = {
  name: 'sync_status',
  inputSchema: z.object({ job_id: z.string().uuid().optional(), account_id: AccountIdSchema.optional() }),
};

export const sync_pause = {
  name: 'sync_pause',
  inputSchema: z.object({ job_id: z.string().uuid() }),
};

export const sync_cancel = {
  name: 'sync_cancel',
  inputSchema: z.object({ job_id: z.string().uuid() }),
};

export const sync_resume = {
  name: 'sync_resume',
  inputSchema: z.object({ job_id: z.string().uuid() }),
};

export const sync_coverage = {
  name: 'sync_coverage',
  description: 'Get coverage report — synchronized is a coverage report',
  inputSchema: z.object({ account_id: AccountIdSchema }),
};

export const sync_verify_read = {
  name: 'sync_verify_read',
  description: 'Run read qualification probe',
  inputSchema: z.object({ account_id: AccountIdSchema, operation_id: z.string() }),
};

// --- Archive ---
export const archive_search = {
  name: 'archive_search',
  description: 'Search archive — cursor pagination, opaque identifiers',
  inputSchema: z.object({
    query: z.string(),
    account_id: AccountIdSchema.optional(),
    all: z.boolean().optional(),
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
};

export const archive_get_conversation = {
  name: 'archive_get_conversation',
  inputSchema: z.object({ conversation_id: ConversationIdSchema, account_id: AccountIdSchema }),
};

export const archive_get_turn = {
  name: 'archive_get_turn',
  inputSchema: z.object({ turn_id: TurnIdSchema, account_id: AccountIdSchema }),
};

export const archive_get_provenance = {
  name: 'archive_get_provenance',
  description: 'Every important normalized field points to observation records',
  inputSchema: z.object({ turn_id: TurnIdSchema.optional(), part_id: z.string().uuid().optional(), artifact_id: z.string().uuid().optional() }),
};

export const archive_list_branches = {
  name: 'archive_list_branches',
  inputSchema: z.object({ conversation_id: ConversationIdSchema, account_id: AccountIdSchema }),
};

export const archive_export = {
  name: 'archive_export',
  inputSchema: z.object({ account_id: AccountIdSchema.optional(), conversation_ids: z.array(ConversationIdSchema).optional(), format: z.enum(['json', 'encrypted_bundle']).default('json') }),
};

export const archive_import = {
  name: 'archive_import',
  inputSchema: z.object({ path: z.string(), account_id: AccountIdSchema }),
};

export const archive_get_artifact = {
  name: 'archive_get_artifact',
  inputSchema: z.object({ artifact_id: z.string().uuid(), account_id: AccountIdSchema }),
};

// --- Diagnostics ---
export const diagnostics_capabilities = {
  name: 'diagnostics_capabilities',
  description: 'Recommended first call — explains unavailable/degraded features rather than hiding tools',
  inputSchema: z.object({}),
};

export const diagnostics_protocol_catalog = {
  name: 'diagnostics_protocol_catalog',
  inputSchema: z.object({ operation_id: z.string().optional() }),
};

export const diagnostics_drift = {
  name: 'diagnostics_drift',
  inputSchema: z.object({ operation_id: z.string().optional(), account_id: AccountIdSchema.optional() }),
};

export const diagnostics_evidence = {
  name: 'diagnostics_evidence',
  inputSchema: z.object({ conversation_id: ConversationIdSchema.optional(), account_id: AccountIdSchema.optional() }),
};

export const diagnostics_storage_health = {
  name: 'diagnostics_storage_health',
  inputSchema: z.object({}),
};

export const diagnostics_recover = {
  name: 'diagnostics_recover',
  inputSchema: z.object({}),
};

// --- Analysis ---
export const analysis_profiles_run = {
  name: 'analysis_profiles_run',
  description: 'Run deterministic analysis — operates on immutable corpus snapshots identified by corpus hash',
  inputSchema: z.object({
    account_ids: z.array(AccountIdSchema).optional(),
    completeness: z.array(z.string()).optional(),
  }),
};

export const analysis_profiles_get = {
  name: 'analysis_profiles_get',
  inputSchema: z.object({ run_id: z.string().uuid() }),
};

export const analysis_compare = {
  name: 'analysis_compare',
  inputSchema: z.object({ run_id_a: z.string().uuid(), run_id_b: z.string().uuid() }),
};

export const analysis_excerpts = {
  name: 'analysis_excerpts',
  description: 'Representative excerpts chosen deterministically and link back to provenance',
  inputSchema: z.object({ run_id: z.string().uuid(), metric: z.string() }),
};

export const analysis_experiments = {
  name: 'analysis_experiments',
  description: 'Fingerprinting / similarity gate — only after written question cannot be answered deterministically',
  inputSchema: z.object({ question: z.string(), config: z.record(z.unknown()).optional() }),
};

// --- Maintenance ---
export const maintenance_backup = {
  name: 'maintenance_backup',
  description: 'Encrypted bundles containing DB plus sealed artifacts and manifest — successful only after verification',
  inputSchema: z.object({ path: z.string().optional() }),
};

export const maintenance_restore = {
  name: 'maintenance_restore',
  description: 'Restore is destructive, requires directive, runs only with capture/sync stopped',
  inputSchema: z.object({ path: z.string(), directive_id: z.string().uuid(), directive_args: z.record(z.unknown()) }),
};

export const maintenance_lock = {
  name: 'maintenance_lock',
  inputSchema: z.object({}),
};

export const maintenance_unlock = {
  name: 'maintenance_unlock',
  inputSchema: z.object({ key: z.string().optional() }),
};

// Destructive delete tools requiring directives — MCP cannot mint approval
export const delete_conversation = {
  name: 'delete_conversation',
  description: 'Requires directive minted by trusted GUI or local CLI',
  inputSchema: z.object({
    conversation_id: ConversationIdSchema,
    account_id: AccountIdSchema,
    directive_id: z.string().uuid(),
  }),
};

export const delete_account = {
  name: 'delete_account',
  inputSchema: z.object({
    account_id: AccountIdSchema,
    directive_id: z.string().uuid(),
  }),
};

export const delete_archive = {
  name: 'delete_archive',
  description: 'Archive-wide deletion requires strongest owner gesture',
  inputSchema: z.object({
    directive_id: z.string().uuid(),
    confirm_text: z.string(),
  }),
};

export const allTools = [
  accounts_list,
  accounts_get,
  accounts_begin_signin,
  accounts_identity_probe,
  accounts_set_enabled,
  capture_status,
  capture_pause,
  capture_resume,
  capture_stop_all,
  capture_completeness,
  capture_repair,
  sync_start,
  sync_status,
  sync_pause,
  sync_cancel,
  sync_resume,
  sync_coverage,
  sync_verify_read,
  archive_search,
  archive_get_conversation,
  archive_get_turn,
  archive_get_provenance,
  archive_list_branches,
  archive_export,
  archive_import,
  archive_get_artifact,
  diagnostics_capabilities,
  diagnostics_protocol_catalog,
  diagnostics_drift,
  diagnostics_evidence,
  diagnostics_storage_health,
  diagnostics_recover,
  analysis_profiles_run,
  analysis_profiles_get,
  analysis_compare,
  analysis_excerpts,
  analysis_experiments,
  maintenance_backup,
  maintenance_restore,
  maintenance_lock,
  maintenance_unlock,
  delete_conversation,
  delete_account,
  delete_archive,
];
