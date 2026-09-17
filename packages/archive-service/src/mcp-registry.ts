/**
 * MCP service registry — per §4, GUI and MCP call same typed service registry so semantics cannot drift
 */

import { ArchiveService } from "./index.js";
import { ToolDefinitions } from "@arena-archive/mcp-contract";
// SessionManager would be in shared package in real impl — avoid circular import for P0

export interface ServiceContext {
  archiveService: ArchiveService;
  // sessionManager, syncScheduler, etc. would be here
}

export type ToolHandler = (args: any, ctx: ServiceContext) => Promise<any>;

export class McpServiceRegistry {
  private handlers = new Map<string, ToolHandler>();

  constructor(private ctx: ServiceContext) {
    this.registerDefaults();
  }

  private registerDefaults() {
    // Accounts
    this.handlers.set("accounts_list", async () => {
      return { accounts: [] }; // would list from SessionManager
    });
    this.handlers.set("accounts_get", async (args) => {
      return { account_id: args.account_id, enabled: true };
    });
    this.handlers.set("diagnostics_capabilities", async () => {
      return {
        version: "0.1.0-p0",
        electron: "32.3.3",
        chromium: "128",
        capabilities: {
          capture: true,
          sync: false,
          analysis: false,
          multiAccount: true,
          targetCoverage: {
            page: true,
            iframe: true,
            dedicated_worker: true,
            shared_worker: "needs_browser_cdp_fallback",
            service_worker: "needs_verification",
          },
        },
        degraded: ["shared_worker requires browser-level CDP diagnostic", "service_worker flattened attach needs owner-session verification"],
        unavailable: ["sync qualification pending P4", "analysis pending P7"],
      };
    });
    this.handlers.set("archive_search", async (args) => {
      const results = this.ctx.archiveService.search(args.query, args.account_id);
      return { results: results.slice(0, args.limit ?? 20), count: results.length };
    });
    this.handlers.set("archive_get_conversation", async (args) => {
      const conv = this.ctx.archiveService.getConversation(args.conversation_id, args.account_id);
      if (!conv) throw new Error("E_PARTIAL: not found");
      return conv;
    });
    this.handlers.set("archive_get_turn", async (args) => {
      const turn = this.ctx.archiveService.getTurn(args.turn_id, args.account_id);
      if (!turn) throw new Error("E_PARTIAL: not found");
      return turn;
    });
    this.handlers.set("archive_get_provenance", async (args) => {
      const obs = this.ctx.archiveService.getObservationsForTurn(args.turn_id);
      return { turn_id: args.turn_id, observations: obs };
    });
  }

  getToolDefinitions() {
    return ToolDefinitions;
  }

  async callTool(name: string, args: any): Promise<any> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`E_UNSUPPORTED: tool ${name} not implemented`);
    return handler(args, this.ctx);
  }

  // GUI/MCP parity test helper per §12.2: enumerate service commands
  enumerateCommands(): string[] {
    return Array.from(this.handlers.keys());
  }
}
