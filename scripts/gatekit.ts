import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const GATE_ARTIFACT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'gates');

export type CheckStatus = 'passed' | 'failed' | 'blocked_env' | 'skipped';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  measured: Record<string, unknown>;
  falsifier: string;
  blocked_by?: string;
  error?: string;
}

export interface GateArtifact {
  gate: string;
  version: string;
  produced_at: string;
  run_id: string;
  runtime: { node: string; platform: string; arch: string };
  overall: 'pass' | 'fail' | 'conditional_pass';
  summary: { passed: number; failed: number; blocked_env: number };
  checks: CheckResult[];
}

export class GateRunner {
  checks: CheckResult[] = [];
  readonly gate: string;
  readonly version: string;
  constructor(gate: string, version: string) { this.gate = gate; this.version = version; }

  async check(id: string, title: string, falsifier: string, fn: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<void> {
    try {
      const measured = await fn();
      const failed = measured.__fail === true;
      const error = typeof measured.__error === 'string' ? measured.__error : undefined;
      delete measured.__fail; delete measured.__error;
      this.checks.push({ id, title, status: failed ? 'failed' : 'passed', measured, falsifier, ...(error ? { error } : {}) });
    } catch (e) {
      this.checks.push({ id, title, status: 'failed', measured: {}, falsifier, error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
    }
  }

  blocked(id: string, title: string, falsifier: string, blockedBy: string): void {
    this.checks.push({ id, title, status: 'blocked_env', measured: {}, falsifier, blocked_by: blockedBy });
  }

  async write(outDir = GATE_ARTIFACT_DIR): Promise<GateArtifact> {
    const passed = this.checks.filter((c) => c.status === 'passed').length;
    const failed = this.checks.filter((c) => c.status === 'failed').length;
    const blocked = this.checks.filter((c) => c.status === 'blocked_env').length;
    const artifact: GateArtifact = {
      gate: this.gate,
      version: this.version,
      produced_at: new Date().toISOString(),
      run_id: createHash('sha256').update(JSON.stringify(this.checks) + Date.now()).digest('hex').slice(0, 12),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      overall: failed > 0 ? 'fail' : blocked > 0 ? 'conditional_pass' : 'pass',
      summary: { passed, failed, blocked_env: blocked },
      checks: this.checks,
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, `${this.gate}.json`), JSON.stringify(artifact, null, 2) + '\n');
    return artifact;
  }
}

export function loadLatestGate(name: string): GateArtifact | null {
  try {
    const { readFileSync } = globalThis as never;
    void readFileSync;
    const { readFileSync: rf } = require('node:fs') as { readFileSync: (p: string, enc: string) => string };
    return JSON.parse(rf(join(GATE_ARTIFACT_DIR, `${name}.json`), 'utf8')) as GateArtifact;
  } catch { return null; }
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
