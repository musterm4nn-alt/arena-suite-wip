import { mkdir, writeFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { GATE_ARTIFACT_DIR } from './gatekit.ts';

/**
 * Environment report written to artifacts/gates/env.json. The plan is a macOS
 * product; doctor states plainly what this machine can and cannot verify —
 * agents must read this (and the latest gate) before architecture changes.
 */
async function main(): Promise<void> {
  const facts: Record<string, unknown> = {
    node: process.version,
    platform: platform(),
    arch: arch(),
    darwin: platform() === 'darwin',
    appleSilicon: platform() === 'darwin' && arch() === 'arm64',
    minMacos: '14.0 (per plan §1; pinned Electron major may raise it — record in docs/platform.md)',
    nodeSqlite: await probe(() => import('node:sqlite')).then((r) => r.ok),
    fts5: await probe(async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
      db.close();
    }),
    sqlcipherBinding: await probe(async () => {
      const m = 'better-sqlite3-multiple-ciphers';
      await import(m);
      if (!m) throw new Error('missing');
    }),
    electron: await probe(async () => { await import('electron'); }),
    keychain: platform() === 'darwin' ? await probe(async () => {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((res, rej) => execFile('/usr/bin/security', ['help'], (e) => (e ? rej(e) : res())));
    }) : { ok: false, error: 'not darwin' },
    homedirReadable: await probe(async () => { await statfs(homedir()); }),
    diskFreeBytes: Number((await statfs(process.cwd())).bsize) * Number((await statfs(process.cwd())).bavail),
    workspacePackages: [
      'core', 'schema', 'security', 'capture-core', 'browser-adapter', 'protocol-catalog',
      'artifacts', 'archive-service', 'sync', 'mcp-contract', 'fixtures', 'analysis',
    ],
  };
  const verdict = verdictFor(facts);
  const out = { produced_at: new Date().toISOString(), facts, verdict };
  await mkdir(GATE_ARTIFACT_DIR, { recursive: true });
  await writeFile(join(GATE_ARTIFACT_DIR, 'env.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}

async function probe(fn: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try { await fn(); return { ok: true }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e) }; }
}

function verdictFor(f: Record<string, unknown>): string[] {
  const v: string[] = [];
  const darwin = f.darwin === true;
  v.push(darwin ? 'macOS host: full P0 surface available' : 'NON-macOS host: Electron/Chromium owner-session checks BLOCKED (never faked); all deterministic layers verifiable');
  if ((f.fts5 as { ok?: boolean })?.ok === false) v.push('node:sqlite FTS5 unavailable: archive-service cannot start');
  if ((f.sqlcipherBinding as { ok?: boolean })?.ok !== true) v.push('SQLCipher binding absent: sandbox runs plaintext SQLite — flagged in every gate artifact (never silently)');
  if ((f.keychain as { ok?: boolean })?.ok !== true) v.push('Keychain unavailable: FileKeyWrapper used; security grading deferred to macOS gates');
  return v;
}

await main();
