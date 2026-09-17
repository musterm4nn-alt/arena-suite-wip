import { createConnection, type Socket } from 'node:net';

/**
 * Stdio <-> Unix-socket MCP relay (§12). Deliberately tiny: it parses nothing,
 * only splices newline-delimited frames, so it cannot invent or launder policy.
 *   usage: node apps/mcp-bridge/src/bridge.ts --socket <path>
 * If the service is not up, it retries with backoff and tells the client via
 * an error frame rather than hanging silently.
 */
export function parseArgs(argv: string[]): { socketPath: string; retryMs: number; maxRetries: number } {
  let socketPath = '';
  let retryMs = 250;
  let maxRetries = 20;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--socket') socketPath = argv[++i] ?? '';
    else if (a === '--retry-ms') retryMs = Number(argv[++i]);
    else if (a === '--max-retries') maxRetries = Number(argv[++i]);
  }
  if (!socketPath) throw new Error('usage: bridge --socket <path>');
  return { socketPath, retryMs, maxRetries };
}

export function attachBridge(sock: Socket, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  let toSockBuf = '';
  input.on('data', (d: Buffer | string) => {
    const text = typeof d === 'string' ? d : d.toString('utf8');
    toSockBuf += text;
    let nl: number;
    while ((nl = toSockBuf.indexOf('\n')) >= 0) {
      const line = toSockBuf.slice(0, nl + 1);
      toSockBuf = toSockBuf.slice(nl + 1);
      sock.write(line);
    }
    if (toSockBuf.length > 0 && !sock.writable) sock.write(toSockBuf), toSockBuf = '';
  });
  let toStdBuf = '';
  sock.on('data', (d: Buffer | string) => {
    const text = typeof d === 'string' ? d : d.toString('utf8');
    toStdBuf += text;
    let nl: number;
    while ((nl = toStdBuf.indexOf('\n')) >= 0) {
      output.write(toStdBuf.slice(0, nl + 1));
      toStdBuf = toStdBuf.slice(nl + 1);
    }
  });
  sock.on('end', () => output.end());
  sock.on('error', () => { /* parent handles close */ });
}

export async function runBridge(opts: { socketPath: string; retryMs: number; maxRetries: number }): Promise<Socket> {
  const { socketPath, retryMs, maxRetries } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      const sock = await connect(socketPath);
      attachBridge(sock, process.stdin, process.stdout);
      process.stdin.on('end', () => sock.end());
      sock.on('close', () => process.exit(0));
      return sock;
    } catch (e) {
      if (attempt >= maxRetries) {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'archive service socket unavailable' } }) + '\n');
        process.exitCode = 1;
        throw e;
      }
      await new Promise((r) => setTimeout(r, Math.min(4000, retryMs * 2 ** Math.min(attempt, 4))));
    }
  }
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const onErr = (e: Error): void => { s.destroy(); reject(e); };
    s.once('error', onErr);
    s.once('connect', () => { s.off('error', onErr); resolve(s); });
  });
}

// CLI entry when executed directly
const invoked = process.argv[1] && /mcp-bridge[\\/]src[\\/]bridge\.ts$/.test(process.argv[1]);
if (invoked) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    await runBridge(opts);
  } catch { /* exit code set above */ }
}
