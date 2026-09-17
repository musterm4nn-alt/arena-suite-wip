/**
 * @arena/archive-service/service — typed service registry (plan §12).
 *
 * The GUI and the MCP bridge call the SAME commands. Every command validates
 * input with the @arena/mcp-contract schemas and returns typed ToolErrors.
 * NOTE: the registry exposes directive CONSUME only — minting lives in the
 * trusted GUI/CLI broker (@arena/security DirectiveBroker).
 */
import {
  TOOL_NAMES,
  ToolError,
  parseToolInput,
  type ToolName,
} from "@arena/mcp-contract";
import type { ArchiveDriver } from "./driver.js";
import { ObservationJournal } from "./journal.js";
import { ProtocolCatalog } from "@arena/protocol-catalog";
import { DirectiveBroker, type DirectiveScope } from "@arena/security";

export interface ServiceContext {
  driver: ArchiveDriver;
  journal: ObservationJournal;
  catalog: ProtocolCatalog;
  /** Consume-only view of the directive broker. */
  directives: Pick<DirectiveBroker, "consume" | "outstanding">;
  locked: () => boolean;
}

export type ServiceHandler = (input: unknown, ctx: ServiceContext) => Promise<unknown>;

/** Minimal P0/P1 command set; each plan tool is present so parity tests enumerate fully. */
function stubCapabilities() {
  return {
    capture: "p0-spike",
    storage: "memory-driver",
    note: "P0 hostile spike: live capture + memory journal only.",
  };
}

export function createServiceRegistry(): Record<ToolName, ServiceHandler> {
  const registry = {} as Record<ToolName, ServiceHandler>;

  const needUnlock = (ctx: ServiceContext) => {
    if (ctx.locked()) throw new ToolError("E_LOCKED", "archive is locked");
  };

  for (const name of TOOL_NAMES) {
    registry[name] = async (raw, ctx) => {
      const input = parseToolInput(name, raw) as Record<string, unknown>;
      switch (name) {
        case "diagnostics_capabilities":
          return {
            tools: TOOL_NAMES,
            ...stubCapabilities(),
            outstanding_directives: ctx.directives.outstanding(),
          };
        case "diagnostics_protocol_catalog":
          needUnlock(ctx);
          return { operations: ctx.catalog.list(), drift: ctx.catalog.driftEvents() };
        case "diagnostics_drift":
          needUnlock(ctx);
          return { drift: ctx.catalog.driftEvents() };
        case "diagnostics_storage_health": {
          needUnlock(ctx);
          return { stats: await ctx.driver.stats(), findings: await ctx.driver.integrityCheck() };
        }
        case "diagnostics_evidence": {
          needUnlock(ctx);
          const row = await ctx.driver.getObservation(
            input["account_id"] as string,
            input["observation_id"] as string,
          );
          if (!row) throw new ToolError("E_SCOPE_MISMATCH", "observation not found in account scope");
          return row;
        }
        case "maintenance_delete_conversation":
        case "maintenance_delete_account":
        case "maintenance_delete_archive":
        case "maintenance_restore": {
          needUnlock(ctx);
          const scope = directiveScopeFor(name, input);
          const res = ctx.directives.consume(input["directive_id"] as string, scope);
          if (!res.ok) {
            throw new ToolError(
              "E_CONFIRM_REQUIRED",
              "destructive action requires a separately-minted exact-scope directive",
            );
          }
          // P1+: pause capture/sync, tombstone, transactional delete, vacuum.
          return { deleted: false, reason: "not-implemented-in-p0-spike", scope };
        }
        default:
          // All other tools validate input and report P0 status explicitly.
          return { status: "not-implemented-in-p0-spike", tool: name };
      }
    };
  }
  return registry;
}

function directiveScopeFor(tool: ToolName, input: Record<string, unknown>): DirectiveScope {
  switch (tool) {
    case "maintenance_delete_conversation":
      return {
        kind: "conversation",
        accountId: input["account_id"] as string,
        conversationId: input["conversation_id"] as string,
      };
    case "maintenance_delete_account":
      return { kind: "account", accountId: input["account_id"] as string };
    case "maintenance_delete_archive":
      return { kind: "archive" };
    case "maintenance_restore":
      return { kind: "restore" };
    default:
      throw new ToolError("E_UNSUPPORTED", `no directive scope for ${tool}`);
  }
}

/** GUI/MCP parity helper: every registered tool must be enumerable. */
export function registryToolNames(registry: Record<ToolName, ServiceHandler>): ToolName[] {
  return Object.keys(registry) as ToolName[];
}
