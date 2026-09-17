/**
 * @arena/mcp-contract — MCP tool schemas + typed errors (plan §12).
 *
 * The GUI and the MCP bridge call the SAME typed service registry, so
 * semantics cannot drift (parity is tested by enumerating this registry).
 * There are intentionally NO generic exec/http/sql/shell tools.
 */
import { z } from "zod";

export const ToolErrorCodeSchema = z.enum([
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
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCodeSchema>;

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

/** Account scope: explicit ids or explicit `all` — never inferred from GUI focus. */
export const AccountScopeSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ account_ids: z.array(z.string().uuid()).min(1) }),
]);
export type AccountScope = z.infer<typeof AccountScopeSchema>;

const PaginationSchema = z.object({
  cursor: z.string().min(1).nullable().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

/** Tool name -> zod input schema. This list IS the contract (plan §12.1). */
export const ToolSchemas = {
  // Accounts
  accounts_list: z.object({}).strict(),
  accounts_get: z.object({ account_id: z.string().uuid() }).strict(),
  accounts_begin_signin: z.object({ account_id: z.string().uuid() }).strict(),
  accounts_identity_probe: z.object({ account_id: z.string().uuid() }).strict(),
  accounts_set_enabled: z
    .object({ account_id: z.string().uuid(), enabled: z.boolean() })
    .strict(),
  // Capture
  capture_status: z.object({ scope: AccountScopeSchema }).strict(),
  capture_pause: z.object({ scope: AccountScopeSchema }).strict(),
  capture_resume: z.object({ scope: AccountScopeSchema }).strict(),
  capture_stop_all: z.object({}).strict(),
  capture_completeness: z
    .object({ account_id: z.string().uuid(), conversation_id: z.string().min(1) })
    .strict(),
  capture_repair: z
    .object({ account_id: z.string().uuid(), conversation_id: z.string().min(1) })
    .strict(),
  // Sync
  sync_start: z.object({ scope: AccountScopeSchema }).strict(),
  sync_status: z.object({ job_id: z.string().uuid().nullable().optional() }).strict(),
  sync_pause: z.object({ job_id: z.string().uuid() }).strict(),
  sync_cancel: z.object({ job_id: z.string().uuid() }).strict(),
  sync_resume: z.object({ job_id: z.string().uuid() }).strict(),
  sync_coverage: z.object({ account_id: z.string().uuid() }).strict(),
  sync_verify_read: z
    .object({ account_id: z.string().uuid(), operation_key: z.string().min(1) })
    .strict(),
  // Archive
  archive_search: z
    .object({
      scope: AccountScopeSchema,
      query: z.string().min(1).max(500),
      include_partial: z.boolean().default(false),
    })
    .merge(PaginationSchema)
    .strict(),
  archive_get_conversation: z
    .object({ account_id: z.string().uuid(), conversation_id: z.string().min(1) })
    .strict(),
  archive_get_turn: z
    .object({
      account_id: z.string().uuid(),
      conversation_id: z.string().min(1),
      turn_id: z.string().min(1),
    })
    .strict(),
  archive_get_provenance: z
    .object({ account_id: z.string().uuid(), record_id: z.string().min(1) })
    .strict(),
  archive_list_branches: z
    .object({ account_id: z.string().uuid(), conversation_id: z.string().min(1) })
    .strict(),
  archive_export: z
    .object({
      scope: AccountScopeSchema,
      conversation_ids: z.array(z.string().min(1)).nullable().optional(),
      format: z.enum(["json", "bundle"]),
    })
    .strict(),
  archive_import: z.object({ path: z.string().min(1) }).strict(),
  archive_get_artifact: z
    .object({ account_id: z.string().uuid(), artifact_id: z.string().min(1) })
    .strict(),
  // Diagnostics
  diagnostics_capabilities: z.object({}).strict(),
  diagnostics_protocol_catalog: z.object({}).strict(),
  diagnostics_drift: z.object({ since_ms: z.number().int().nonnegative().nullable().optional() }).strict(),
  diagnostics_evidence: z
    .object({ account_id: z.string().uuid(), observation_id: z.string().uuid() })
    .strict(),
  diagnostics_storage_health: z.object({}).strict(),
  diagnostics_recover: z.object({ dry_run: z.boolean().default(true) }).strict(),
  // Analysis
  analysis_profiles_run: z
    .object({
      scope: AccountScopeSchema,
      cohort: z.string().min(1),
      config: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  analysis_profiles_get: z.object({ run_id: z.string().min(1) }).strict(),
  analysis_compare: z
    .object({ run_ids: z.array(z.string().min(1)).min(2).max(8) })
    .strict(),
  analysis_excerpts: z
    .object({ run_id: z.string().min(1), metric: z.string().min(1) })
    .merge(PaginationSchema)
    .strict(),
  analysis_experiments: z.object({}).strict(),
  // Maintenance (+ destructive tools requiring directives)
  maintenance_backup: z.object({ path: z.string().min(1) }).strict(),
  maintenance_restore: z
    .object({ path: z.string().min(1), directive_id: z.string().min(1) })
    .strict(),
  maintenance_lock: z.object({}).strict(),
  maintenance_unlock: z.object({}).strict(),
  maintenance_delete_conversation: z
    .object({
      account_id: z.string().uuid(),
      conversation_id: z.string().min(1),
      directive_id: z.string().min(1),
    })
    .strict(),
  maintenance_delete_account: z
    .object({ account_id: z.string().uuid(), directive_id: z.string().min(1) })
    .strict(),
  maintenance_delete_archive: z.object({ directive_id: z.string().min(1) }).strict(),
} satisfies Record<string, z.ZodTypeAny>;

export type ToolName = keyof typeof ToolSchemas;
export const TOOL_NAMES: ToolName[] = Object.keys(ToolSchemas) as ToolName[];

/** Tools that require a separately-minted exact-scope directive. */
export const DIRECTIVE_GATED_TOOLS: ToolName[] = [
  "maintenance_restore",
  "maintenance_delete_conversation",
  "maintenance_delete_account",
  "maintenance_delete_archive",
];

export function parseToolInput<T extends ToolName>(
  tool: T,
  input: unknown,
): z.infer<(typeof ToolSchemas)[T]> {
  return (ToolSchemas[tool] as z.ZodTypeAny).parse(input);
}
