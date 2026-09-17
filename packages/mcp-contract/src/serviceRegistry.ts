import { allTools } from './tools/definitions.js';
import { McpError } from './errors.js';

/**
 * Service registry — GUI and MCP call same typed service registry so semantics cannot drift
 * No essential workflow is GUI-only; owner-attended steps are represented as NEEDS_OWNER_INTERACTION states
 * Do not expose generic arbitrary JavaScript, arbitrary HTTP request, raw SQL or shell execution as MCP tools
 */

export type ServiceHandler = (args: unknown) => Promise<unknown>;

export class ServiceRegistry {
  private handlers = new Map<string, ServiceHandler>();
  private trustedOnly = new Set<string>(); // tools that require trusted GUI, not MCP

  constructor() {
    // Mark directive creation as trusted-only — MCP cannot mint approval
    this.trustedOnly.add('create_directive');
  }

  register(toolName: string, handler: ServiceHandler): void {
    this.handlers.set(toolName, handler);
  }

  async call(toolName: string, args: unknown, context: { isTrusted: boolean; accountId?: string }): Promise<unknown> {
    if (this.trustedOnly.has(toolName) && !context.isTrusted) {
      throw new McpError('E_CONFIRM_REQUIRED', `Tool ${toolName} requires trusted GUI or local CLI, not MCP`, { toolName });
    }

    // Every tool that touches account data accepts explicit account IDs or explicit all sentinel; never inferred from GUI focus
    const toolDef = allTools.find(t => t.name === toolName);
    if (!toolDef) {
      throw new McpError('E_UNSUPPORTED', `Unknown tool ${toolName}`);
    }

    const handler = this.handlers.get(toolName);
    if (!handler) {
      // For unimplemented, return NEEDS_OWNER_INTERACTION or capability explanation rather than hiding
      throw new McpError('E_UNSUPPORTED', `Tool ${toolName} not yet implemented — check diagnostics_capabilities`, { toolName });
    }

    // Validate account scope explicitness
    if (toolDef.inputSchema) {
      const parsed = toolDef.inputSchema.safeParse(args);
      if (!parsed.success) {
        throw new McpError('E_SCOPE_MISMATCH', `Invalid args for ${toolName}: ${parsed.error.message}`, { toolName });
      }
    }

    return handler(args);
  }

  listTools(): typeof allTools {
    return allTools;
  }

  // For parity test in CI — enumerate service commands
  getRegisteredToolNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  getAllToolNames(): string[] {
    return allTools.map(t => t.name);
  }

  checkParity(): { missingInRegistry: string[]; extraInRegistry: string[]; parity: boolean } {
    const allNames = new Set(this.getAllToolNames());
    const registered = new Set(this.getRegisteredToolNames());
    const missing = Array.from(allNames).filter(n => !registered.has(n));
    const extra = Array.from(registered).filter(n => !allNames.has(n));
    return { missingInRegistry: missing, extraInRegistry: extra, parity: missing.length === 0 && extra.length === 0 };
  }
}
