import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { ArchiveError, isArchiveError } from '@arena/core';
import { ArchiveService } from './service.ts';

/**
 * MCP transport (§12): the archive service owns a Unix domain socket, mode
 * 0600; the stdio bridge relays MCP client traffic here. Line-delimited
 * JSON-RPC 2.0 implementing the MCP subset: initialize / tools/list /
 * tools/call / ping. Tool *schemas* come from packages/mcp-contract so the
 * GUI, the CLI and MCP all resolve to the same service registry (§12.2).
 *
 * Production adds: pidfile/lease so a live socket is never clobbered, and the
 * optional loopback Streamable HTTP variant with bearer token + Host/Origin
 * validation. Those are macOS-build surfaces; framing here is identical.
 */

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerOptions {
  socketPath: string;
  tools: ToolSpec[];
  onCall: (name: string, args: unknown) => Promise<unknown>;
}

export class McpUdsServer {
  #server: Server;
  #opts: McpServerOptions;
  #sockets = new Set<Socket>();

  constructor(opts: McpServerOptions) {
    this.#opts = opts;
    // A stale socket file from a crashed run is unlinked; a live one would fail
    // listen with EADDRINUSE-style error surfaced by .listen().
    if (existsSync(opts.socketPath)) {
      try { unlinkSync(opts.socketPath); } catch { /* raced or foreign: listen will surface the error */ }
    }
    this.#server = createServer((sock) => this.#onSocket(sock));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onErr = (e: Error): void => { this.#server.off('listening', onOk); reject(e); };
      const onOk = (): void => {
        this.#server.off('error', onErr);
        try { chmodSync(this.#opts.socketPath, 0o600); } catch { /* non-POSIX */ }
        resolve();
      };
      this.#server.once('error', onErr);
      this.#server.once('listening', onOk);
      this.#server.listen(this.#opts.socketPath);
    });
  }

  #onSocket(sock: Socket): void {
    this.#sockets.add(sock);
    let buf = '';
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        void this.#handleLine(sock, line);
      }
      if (buf.length > 4 * 1024 * 1024) { sock.destroy(new Error('line too long')); buf = ''; }
    });
    sock.on('close', () => this.#sockets.delete(sock));
    sock.on('error', () => this.#sockets.delete(sock));
  }

  async #handleLine(sock: Socket, line: string): Promise<void> {
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; } catch {
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
      return;
    }
    if (msg.method === undefined) return;
    const id = msg.id ?? null;
    switch (msg.method) {
      case 'initialize':
        sock.write(jsonOk(id, {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'arena-model-archive', version: '0.1.0' },
        }));
        return;
      case 'ping':
        sock.write(jsonOk(id, {}));
        return;
      case 'tools/list':
        sock.write(jsonOk(id, { tools: this.#opts.tools }));
        return;
      case 'tools/call': {
        const p = msg.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!p?.name) {
          sock.write(jsonOk(id, { content: [{ type: 'text', text: JSON.stringify({ error: 'E_INVALID_ARGS', message: 'tools/call requires name' }) }], isError: true }));
          return;
        }
        try {
          const result = await this.#opts.onCall(p.name, p.arguments ?? {});
          sock.write(jsonOk(id, { content: [{ type: 'text', text: JSON.stringify(result ?? null) }], isError: false }));
        } catch (e) {
          const err = isArchiveError(e) ? e.toJSON() : { error: 'E_INTERNAL', message: 'internal error' };
          // MCP semantics: tool failure is an isError result, not a transport fault.
          sock.write(jsonOk(id, { content: [{ type: 'text', text: JSON.stringify(err) }], isError: true }));
        }
        return;
      }
      default:
        sock.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } }) + '\n');
    }
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((res) => this.#server.close(() => res()));
    try { if (existsSync(this.#opts.socketPath)) unlinkSync(this.#opts.socketPath); } catch { /* gone */ }
  }
}

function jsonOk(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

/** Minimal client used by gates/tests. */
export class McpLineClient {
  #sock: Socket;
  #pending = new Map<number, { res: (v: RpcMessage) => void; rej: (e: Error) => void }>();
  #nextId = 1;
  #buf = '';
  #dead = false;

  constructor(socketPath: string) {
    this.#sock = createConnection(socketPath);
    this.#sock.setEncoding('utf8');
    this.#sock.on('data', (d: string | Buffer) => {
      this.#buf += typeof d === 'string' ? d : d.toString('utf8');
      let nl: number;
      while ((nl = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, nl);
        this.#buf = this.#buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: RpcMessage;
        try { msg = JSON.parse(line) as RpcMessage; } catch { continue; }
        if (msg.id !== undefined && msg.id !== null && this.#pending.has(Number(msg.id))) {
          const h = this.#pending.get(Number(msg.id))!;
          this.#pending.delete(Number(msg.id));
          h.res(msg);
        }
      }
    });
    this.#sock.on('error', (e) => this.#failAll(e));
    this.#sock.on('close', () => this.#failAll(new Error('connection closed')));
  }

  #failAll(e: Error): void {
    if (this.#dead) return;
    this.#dead = true;
    for (const { rej } of this.#pending.values()) rej(e);
    this.#pending.clear();
  }

  ready(): Promise<void> {
    return new Promise((res, rej) => {
      if (this.#sock.connecting) { this.#sock.once('connect', () => res()); this.#sock.once('error', rej); }
      else res();
    });
  }

  request(method: string, params?: unknown): Promise<RpcMessage> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (this.#dead) { reject(new Error('client closed')); return; }
      this.#pending.set(id, { res: resolve, rej: reject });
      this.#sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  close(): void { this.#sock.destroy(); }
}

/** Direct service RPC (GUI/CLI local IPC path, same registry as MCP). */
export function attachServiceRpc(service: ArchiveService, socketPath: string): { close: () => Promise<void> } {
  if (existsSync(socketPath)) { try { unlinkSync(socketPath); } catch { /* raced */ } }
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        void (async () => {
          let id: number | string | null = null;
          try {
            const req = JSON.parse(line) as { id?: number | string; command?: string; args?: unknown };
            id = req.id ?? null;
            const res = await service.dispatch(String(req.command), req.args);
            sock.write(JSON.stringify({ id, ok: true, result: res }) + '\n');
          } catch (e) {
            const err = isArchiveError(e) ? e.toJSON() : { error: 'E_INTERNAL', message: 'internal error' };
            sock.write(JSON.stringify({ id, ok: false, error: err }) + '\n');
          }
        })();
      }
    });
    sock.on('error', () => sock.destroy());
  });
  server.listen(socketPath);
  try { chmodSync(socketPath, 0o600); } catch { /* posix */ }
  return {
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      try { unlinkSync(socketPath); } catch { /* gone */ }
    },
  };
}

export { ArchiveError };
