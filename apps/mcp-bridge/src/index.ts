/**
 * MCP Bridge — stdio <-> Unix domain socket per §12
 * Default transport: tiny stdio bridge process connects to Unix domain socket owned by running archive service, mode 0600
 * Optional Streamable HTTP only when client cannot use stdio
 */

import { createServer, Socket } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, chmod } from "node:fs/promises";
import { ToolDefinitions } from "@arena-archive/mcp-contract";

const SOCKET_PATH = process.env.ARENA_ARCHIVE_SOCKET || join(homedir(), ".config", "ArenaArchive", "archive.sock");

async function startSocketServer() {
  await mkdir(join(homedir(), ".config", "ArenaArchive"), { recursive: true });
  // Remove stale socket
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(SOCKET_PATH);
  } catch {}

  const server = createServer((socket: Socket) => {
    console.log("[MCP Bridge] client connected via UDS");
    socket.on("data", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(msg, socket);
      } catch (e) {
        socket.write(JSON.stringify({ error: "invalid_json" }) + "\n");
      }
    });
  });

  server.listen(SOCKET_PATH, async () => {
    await chmod(SOCKET_PATH, 0o600);
    console.log(`[MCP Bridge] listening on ${SOCKET_PATH} mode 0600`);
  });

  return server;
}

function handleMessage(msg: any, socket: Socket) {
  // Simplified MCP handling — real impl would use @modelcontextprotocol/sdk
  if (msg.method === "initialize") {
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "arena-archive",
            version: "0.1.0-p0",
          },
        },
      }) + "\n"
    );
  } else if (msg.method === "tools/list") {
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: ToolDefinitions.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input,
          })),
        },
      }) + "\n"
    );
  } else if (msg.method === "tools/call") {
    const toolName = msg.params?.name;
    console.log(`[MCP Bridge] tool call ${toolName} params=${JSON.stringify(msg.params?.arguments)}`);
    // Route to archive service — for P0, mock responses
    if (toolName === "diagnostics_capabilities") {
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  version: "0.1.0-p0",
                  electron: "32.3.3",
                  chromium: "128",
                  capabilities: {
                    capture: true,
                    sync: false, // not yet qualified
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
                }),
              },
            ],
          },
        }) + "\n"
      );
    } else {
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Tool ${toolName} not yet implemented in P0` },
        }) + "\n"
      );
    }
  }
}

// stdio bridge
function startStdioBridge() {
  console.log("[MCP Bridge] stdio bridge starting, connecting to UDS");

  // In real impl, this process would be spawned by LLM client with stdio, and it connects to UDS
  // For simplicity, we handle stdio directly
  process.stdin.on("data", (data) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        // Forward to UDS client? For P0, handle inline
        const mockSocket = {
          write: (out: string) => process.stdout.write(out),
        } as unknown as Socket;
        handleMessage(msg, mockSocket);
      } catch (e) {
        process.stdout.write(JSON.stringify({ error: "invalid_json" }) + "\n");
      }
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--socket-server")) {
    await startSocketServer();
  } else {
    startStdioBridge();
    // Also try to start socket server if not running? For P0, we run both in dev
    await startSocketServer().catch(() => {});
  }
}

main();
