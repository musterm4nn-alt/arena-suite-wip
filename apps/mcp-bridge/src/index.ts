/**
 * Tiny stdio <-> UDS relay — default transport per section 12
 * Stdio bridge connects to Unix domain socket owned by running archive service, mode 0600
 * Gives normal MCP client ergonomics without leaving TCP listener
 * Optional Streamable HTTP on 127.0.0.1 may be enabled explicitly for clients that require it;
 * use ephemeral port, bearer token, Host/Origin validation, no CORS, block Arena sessions from loopback
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_SOCKET_PATH = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'ArenaArchive', 'mcp.sock')
  : path.join(os.homedir(), '.config', 'arena-archive', 'mcp.sock');

export class McpBridge {
  private socketPath: string;
  private client: net.Socket | null = null;

  constructor(socketPath = DEFAULT_SOCKET_PATH) {
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    console.error(`[MCP Bridge] Connecting to archive service at ${this.socketPath}`);

    // Check if socket exists
    try {
      await fs.promises.access(this.socketPath);
    } catch {
      console.error(`[MCP Bridge] Socket not found — archive service not running? Starting mock mode`);
      this.startMockMode();
      return;
    }

    this.client = net.createConnection(this.socketPath);

    this.client.on('connect', () => {
      console.error('[MCP Bridge] Connected to archive service');
    });

    this.client.on('data', (data) => {
      // Relay from UDS to stdio (stdout)
      process.stdout.write(data);
    });

    this.client.on('error', (err) => {
      console.error(`[MCP Bridge] Socket error: ${err.message} — falling back to mock`);
      this.startMockMode();
    });

    this.client.on('close', () => {
      console.error('[MCP Bridge] Socket closed');
      process.exit(0);
    });

    // Relay from stdio (stdin) to UDS
    process.stdin.on('data', (data) => {
      if (this.client && !this.client.destroyed) {
        this.client.write(data);
      }
    });

    process.stdin.on('end', () => {
      this.client?.end();
    });
  }

  private startMockMode(): void {
    console.error('[MCP Bridge] Mock mode — echoing MCP tool list');

    // Minimal MCP stdio handling — parse JSON-RPC
    let buffer = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          this.handleMockMessage(msg);
        } catch (e) {
          console.error(`[MCP Bridge] Failed to parse: ${line.slice(0, 100)}`);
        }
      }
    });
  }

  private handleMockMessage(msg: any): void {
    const id = msg.id;
    const method = msg.method;

    if (method === 'initialize') {
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'arena-archive-mock', version: '0.1.0' },
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }

    if (method === 'tools/list') {
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            { name: 'diagnostics_capabilities', description: 'Recommended first call — explains unavailable/degraded features', inputSchema: { type: 'object', properties: {} } },
            { name: 'accounts_list', description: 'List all local accounts', inputSchema: { type: 'object', properties: {} } },
            { name: 'capture_status', description: 'Get capture status', inputSchema: { type: 'object', properties: { account_id: { type: 'string' } } } },
            { name: 'archive_search', description: 'Search archive', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }

    if (method === 'tools/call') {
      const toolName = msg.params?.name;
      const response = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Mock response for tool ${toolName} — archive service not running. Run diagnostics_capabilities for real capabilities.` }],
        },
      };
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }

    // Default: method not found
    const response = {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method} (mock mode)` },
    };
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}

// Run if executed directly
const isBridgeMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.includes('mcp-bridge');
if (isBridgeMain) {
  const bridge = new McpBridge(process.env.ARENA_MCP_SOCKET ?? DEFAULT_SOCKET_PATH);
  bridge.start().catch(err => {
    console.error('[MCP Bridge] Failed to start', err);
    process.exit(1);
  });
}
