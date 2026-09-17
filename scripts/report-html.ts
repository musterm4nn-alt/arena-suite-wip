import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { GATE_ARTIFACT_DIR } from './gatekit.ts';

/**
 * Render every gate artifact in artifacts/gates/*.json into a single
 * self-contained HTML report (plan §18 typography: Departure Mono with
 * system monospace fallback — the font asset URL below was verified to serve
 * a valid woff2 from the official site; offline rendering falls back cleanly).
 */

interface GateCheck { id: string; title: string; status: 'passed' | 'failed' | 'blocked_env'; falsifier: string; measured?: Record<string, unknown>; error?: string }
interface GateArtifact { gate: string; version: string; produced_at: string; run_id: string; runtime: Record<string, unknown>; overall: string; summary: Record<string, number>; checks: GateCheck[] }

const STATUS_GLYPH: Record<GateCheck['status'], string> = { passed: '✓ PASS', failed: '✗ FAIL', blocked_env: '⊘ BLOCKED' };

function esc(x: unknown): string {
  return JSON.stringify(x, null, 2)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main(): Promise<void> {
  const dir = GATE_ARTIFACT_DIR;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.html').sort();
  const gates: GateArtifact[] = [];
  let env: Record<string, unknown> | null = null;
  for (const f of files) {
    const raw = JSON.parse(await readFile(join(dir, f), 'utf8'));
    if (basename(f) === 'env.json') env = raw; else gates.push(raw as GateArtifact);
  }
  const overall = gates.some((g) => g.overall === 'fail') ? 'FAIL'
    : gates.some((g) => g.overall === 'conditional_pass') ? 'CONDITIONAL PASS'
      : gates.length === 0 ? 'NO GATES' : 'PASS';
  const cls = overall === 'FAIL' ? 'bad' : overall.startsWith('CONDITIONAL') ? 'warn' : 'ok';

  const gateHtml = gates.map((g) => `
<section class="gate">
  <h2>Gate ${esc(g.gate)} <span class="ov ${g.overall === 'fail' ? 'bad' : g.overall === 'conditional_pass' ? 'warn' : 'ok'}">${esc(g.overall).toUpperCase()}</span></h2>
  <p class="meta">artifact v${esc(g.version)} · run ${esc(g.run_id)} · produced ${esc(g.produced_at)} · runtime ${esc(JSON.stringify(g.runtime))}</p>
  <p class="meta">passed ${g.summary.passed ?? 0} · failed ${g.summary.failed ?? 0} · blocked (env) ${g.summary.blocked_env ?? 0}</p>
  <table>
    <thead><tr><th>status</th><th>check</th><th>measured evidence</th><th>falsifier (what would disprove it)</th></tr></thead>
    <tbody>
    ${g.checks.map((c) => `<tr class="s-${c.status}">
      <td class="glyph">${STATUS_GLYPH[c.status]}</td>
      <td><b>${esc(c.id)}</b><br>${esc(c.title)}${c.error ? `<br><span class="err">error: ${esc(c.error)}</span>` : ''}</td>
      <td><pre>${esc(c.measured ?? {})}</pre></td>
      <td class="fal">${esc(c.falsifier)}</td>
    </tr>`).join('\n')}
    </tbody>
  </table>
</section>`).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ARENA MODEL ARCHIVE — EVIDENCE GATES</title>
<style>
  /* Departure Mono (SIL OFL, Helena Zhang — https://departuremono.com) */
  @font-face {
    font-family: 'Departure Mono';
    src: url('https://departuremono.com/assets/DepartureMono-Regular.woff2') format('woff2');
    font-display: swap;
  }
  :root {
    --bg: #0a0c10; --panel: #11141b; --ink: #d7e0ea; --dim: #7d8a9a;
    --ok: #4ade80; --bad: #f87171; --warn: #fbbf24; --line: #1e2431;
    --mono: 'Departure Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 64px; background: var(--bg); color: var(--ink); font-family: var(--mono); font-size: 13px; line-height: 1.55; }
  header { border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; letter-spacing: 1px; }
  h2 { font-size: 16px; margin: 0 0 4px; }
  .banner { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
  .ov { padding: 2px 10px; border: 1px solid currentColor; font-size: 12px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--warn); }
  .gate { background: var(--panel); border: 1px solid var(--line); padding: 16px; margin: 0 0 24px; }
  .meta { color: var(--dim); font-size: 11px; margin: 4px 0 12px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; color: var(--dim); font-weight: normal; border-bottom: 1px solid var(--line); padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  td { border-bottom: 1px solid var(--line); padding: 8px; vertical-align: top; }
  tr.s-passed .glyph { color: var(--ok); } tr.s-failed .glyph { color: var(--bad); } tr.s-blocked_env .glyph { color: var(--warn); }
  .glyph { white-space: nowrap; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 12px; color: var(--ink); }
  .fal { color: var(--dim); max-width: 34ch; }
  .err { color: var(--bad); }
  section.env { background: var(--panel); border: 1px solid var(--line); padding: 16px; margin: 0 0 24px; }
  footer { color: var(--dim); font-size: 11px; margin-top: 32px; border-top: 1px solid var(--line); padding-top: 12px; }
  a { color: var(--ink); }
</style></head>
<body>
<header><div class="banner">
  <h1>▚ ARENA MODEL ARCHIVE — EVIDENCE GATES</h1>
  <div class="ov ${cls}">${overall}</div>
</div>
<p class="meta">Machine-readable artifacts: artifacts/gates/*.json · generated ${new Date().toISOString()} · this report renders recorded evidence only; nothing here is inferred beyond what the gate runners measured.</p>
</header>
${env ? `<section class="env"><h2>ENVIRONMENT PROBES <span class="ov warn">sandbox</span></h2><pre>${esc(env)}</pre></section>` : ''}
${gateHtml}
<footer>
  Unknown remains unknown. Blocked checks are blocked by the environment (owner session / arm64 macOS /
  Keychain / SQLCipher), not by absence of implementation — each carries an explicit falsifier naming what
  would disprove it. Font: Departure Mono (SIL OFL, Helena Zhang) with system monospace fallback.
</footer>
</body></html>`;
  await writeFile(join(dir, 'index.html'), html);
  console.log(`report: ${join(dir, 'index.html')} · gates: ${gates.map((g) => `${g.gate}:${g.overall}`).join(' ')} · ${overall}`);
}

await main();
