import type { ToolSpec } from '@arena/archive-service';

/**
 * MCP tool contract (§12). Each tool maps 1:1 to a service command — the GUI
 * and MCP call the same registry so semantics cannot drift. Tool *definitions*
 * live here; *behavior* lives in archive-service.
 *
 * Contract rules encoded:
 * - every account-touching tool takes explicit scope (never "currently focused")
 * - destructive tools require directive_id (minted only by the trusted GUI/CLI)
 * - deliberately absent: arbitrary JS, arbitrary HTTP, raw SQL, shell (§12.2)
 */

const SCOPE_NOTE = 'account scope is explicit; never inferred from GUI focus';

export const TOOL_DEFINITIONS: Array<ToolSpec & { command: string }> = [
  // accounts
  spec('accounts_list', 'accounts', 'List local archive accounts.', {}),
  spec('accounts_get', 'accounts', 'Get one account by local id.', { account_id: str() }),
  spec('accounts_create', 'accounts', 'Create a local account with explicit partition storage path.', { label: str(), storage_path: str() }),
  spec('accounts_begin_signin', 'accounts', 'Open the owner-driven sign-in flow. Returns NEEDS_OWNER_INTERACTION; the app never reads mail or solves challenges.', { account_id: str() }),
  spec('accounts_identity_probe', 'accounts', 'Probe identity for the active session epoch.', { account_id: str() }),
  spec('accounts_set_enabled', 'accounts', 'Enable or disable an account.', { account_id: str(), enabled: boolean() }),

  // capture
  spec('capture_status', 'capture', 'Per-account capture state incl. queue metrics and high-water marks.', {}),
  spec('capture_pause', 'capture', `Pause capture. ${SCOPE_NOTE}.`, scopeArg()),
  spec('capture_resume', 'capture', `Resume capture. ${SCOPE_NOTE}.`, scopeArg()),
  spec('capture_stop_all', 'capture', 'Close all capture views (does not delete evidence).', {}),
  spec('capture_completeness', 'capture', 'Completeness distribution for an account.', { account_id: str() }),
  spec('capture_repair', 'capture', 'Drain/normalize queued observations after a gap.', { account_id: str() }),

  // sync
  spec('sync_start', 'sync', 'Start a backfill job for one account (queued->running; resumable checkpoints).', { account_id: str() }),
  spec('sync_status', 'sync', 'Job state incl. blocking reason.', { job_id: str() }),
  spec('sync_pause', 'sync', 'Pause a job at its checkpoint.', { job_id: str() }),
  spec('sync_resume', 'sync', 'Resume a paused job (re-probes identity first).', { job_id: str() }),
  spec('sync_cancel', 'sync', 'Cancel a job; partial coverage remains visible.', { job_id: str() }),
  spec('sync_coverage', 'sync', 'Coverage report — explicitly not a completeness claim.', { account_id: str() }),
  spec('sync_verify_read', 'sync', 'Run the read-qualification probe for one catalog op (owner session required).', { account_id: str(), op_id: str() }),

  // archive
  spec('archive_search', 'archive', 'FTS search within one account; opaque cursor pagination.', { account_id: str(), query: str(), cursor: strOpt(), limit: numOpt() }),
  spec('archive_get_conversation', 'archive', 'Conversation with branches and turns.', { conversation_id: str() }),
  spec('archive_get_turn', 'archive', 'Turn incl. completeness and terminal evidence.', { turn_id: str() }),
  spec('archive_get_provenance', 'archive', 'Observation ids backing a normalized field.', { entity_table: enumOf('part', 'turn', 'conversation'), entity_id: str() }),
  spec('archive_list_branches', 'archive', 'Branch tree of a conversation (regenerations are branches, never replacements).', { conversation_id: str() }),
  spec('archive_export', 'archive', 'Export a sanitized JSON bundle for account/conversations.', { account_id: str(), conversation_ids: arrOpt() }),
  spec('archive_import', 'archive', 'Import an export bundle (source=import; separate cohort).', { account_id: str(), bundle: obj() }),
  spec('archive_get_artifact', 'archive', 'Retrieve a sealed artifact (requires unlocked key; disabled in headless mode).', { artifact_id: str() }),

  // diagnostics
  spec('diagnostics_capabilities', 'diagnostics', 'Recommended first call: explains unavailable/degraded features instead of hiding tools.', {}),
  spec('diagnostics_protocol_catalog', 'diagnostics', 'Catalog operations, evidence states, drift counters.', {}),
  spec('diagnostics_drift', 'diagnostics', 'Recent drift events.', {}),
  spec('diagnostics_evidence', 'diagnostics', 'Observation rows for one request (sanitized).', { account_id: str(), request_id: str() }),
  spec('diagnostics_storage_health', 'diagnostics', 'Counts, conflicts, DB health.', {}),
  spec('diagnostics_recover', 'diagnostics', 'Integrity check; optional FTS rebuild; staging recovery.', { rebuild_fts: boolOpt() }),

  // analysis
  spec('analysis_profiles_run', 'analysis', 'Run deterministic profiles over the complete-turn corpus; returns run id.', { account_id: str() }),
  spec('analysis_profiles_get', 'analysis', 'Fetch a stored run report.', { run_id: str() }),
  spec('analysis_compare', 'analysis', 'Compare two or more run reports.', { run_ids: arr() }),
  spec('analysis_excerpts', 'analysis', 'Deterministic representative excerpts.', { run_id: str(), n: numOpt() }),
  spec('analysis_experiments', 'analysis', 'ML experiments (gated; typically E_UNSUPPORTED).', { kind: str() }),

  // maintenance
  spec('maintenance_lock', 'maintenance', 'Lock the archive for maintenance.', { token: strOpt() }),
  spec('maintenance_unlock', 'maintenance', 'Unlock with the token issued at lock time.', { token: str() }),
  spec('maintenance_backup', 'maintenance', 'Create verified encrypted backup bundle.', { destination: str() }),
  spec('maintenance_restore', 'maintenance', 'Restore from bundle — destructive, requires directive, capture/sync stopped.', { bundle_dir: str(), directive_id: str() }, true),

  // destructive
  spec('maintenance_delete_conversation', 'maintenance', 'Delete a conversation. Requires a trusted single-use directive bound to the exact canonical scope.', { conversation_id: str(), directive_id: str() }, true),
  spec('maintenance_delete_account', 'maintenance', 'Delete an account scope. Requires directive.', { account_id: str(), directive_id: str() }, true),
];

function spec(name: string, domain: string, description: string, props: Record<string, unknown>, destructive = false): ToolSpec & { command: string } {
  return {
    name,
    description: `[${domain}] ${description}${destructive ? ' [DESTRUCTIVE: directive required; E_CONFIRM_REQUIRED on mismatch/expiry/replay]' : ''}`,
    inputSchema: { type: 'object', properties: props, additionalProperties: false },
    command: name,
  };
}

function str() { return { type: 'string' }; }
function strOpt() { return { type: 'string', nullable: true }; }
function boolean() { return { type: 'boolean' }; }
function boolOpt() { return { type: 'boolean' }; }
function numOpt() { return { type: 'integer', minimum: 1, maximum: 200 }; }
function arr() { return { type: 'array', items: { type: 'string' } }; }
function arrOpt() { return { type: 'array', items: { type: 'string' } }; }
function obj() { return { type: 'object' }; }
function enumOf(...v: string[]) { return { type: 'string', enum: v }; }
function scopeArg() {
  return {
    oneOf: [
      { type: 'object', properties: { account_id: str() }, required: ['account_id'], additionalProperties: false },
      { type: 'object', properties: { all: boolean() }, required: ['all'], additionalProperties: false },
    ],
  };
}

/** Names that MUST NOT exist (escape hatches erase the security model). */
export const FORBIDDEN_TOOLS = [
  'eval_js', 'execute_js', 'run_script', 'sql', 'raw_sql', 'query_sql', 'http_fetch',
  'fetch_url', 'browser_navigate', 'shell', 'exec', 'read_file', 'write_file',
  'mint_delete_directive', 'approve_destructive',
];
