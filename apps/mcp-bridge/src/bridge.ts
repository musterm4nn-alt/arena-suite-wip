#!/usr/bin/env node
/**
 * @arena/mcp-bridge — tiny stdio <-> Unix-domain-socket relay (plan §12).
 *
 * Default transport: MCP client speaks stdio to this process; this process
 * relays newline-delimited JSON-RPC frames to the archive service's UDS
 * (mode 0600). No TCP listener, no business logic, no secret handling.
 *
 * Wire format over UDS: one JSON-RPC message per line (\\n-delimited UTF-8).
 */
import * as net from "node:net";

const SOCKET_ENV = "ARENA_ARCHIVE_SOCKET";

function socketPath(): string {
  const p = process.env[SOCKET_ENV];
  if (!p) {
    throw new Error(`${SOCKET_ENV} is not set (path to archive-service socket)`);
  }
  return p;
}

async function main(): Promise<void> {
  const sock = net.createConnection(socketPath());
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });

  process.stdin.on("data", (chunk: Buffer) => {
    if (!sock.write(chunk)) process.stdin.pause();
  });
  sock.on("drain", () => process.stdin.resume());
  sock.on("data", (chunk: Buffer) => {
    if (!process.stdout.write(chunk)) sock.pause();
  });
  process.stdout.on("drain", () => sock.resume());

  const shutdown = () => {
    try {
      sock.end();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  sock.on("close", () => process.exit(0));
  sock.on("error", (err) => {
    process.stderr.write(`mcp-bridge socket error: ${String(err)}\n`);
    process.exit(1);
  });
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}

main().catch((err) => {
  process.stderr.write(`mcp-bridge failed: ${String(err)}\n`);
  process.exit(1);
});
