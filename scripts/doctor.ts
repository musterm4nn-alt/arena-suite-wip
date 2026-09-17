/**
 * doctor.ts — environment check per docs/platform.md
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function check(cmd: string): { ok: boolean; version?: string; error?: string } {
  try {
    const out = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { ok: true, version: out.split("\n")[0] };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

console.log("=== Arena Archive Doctor ===");
console.log(`Node: ${process.version} (required >=20)`);
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`Electron pinned: 32.3.3 Chromium 128`);

const checks = [
  { name: "node >=20", cmd: "node --version", required: true },
  { name: "npm", cmd: "npm --version", required: true },
  { name: "electron (npx)", cmd: "npx electron --version", required: false },
  { name: "tsx", cmd: "npx tsx --version", required: true },
];

for (const c of checks) {
  const res = check(c.cmd);
  console.log(`${res.ok ? "✓" : c.required ? "✗" : "○"} ${c.name}: ${res.version ?? res.error}`);
}

console.log("\nDirectories:");
const dirs = ["apps/desktop", "packages/browser-adapter", "packages/capture-core", "packages/archive-service", "packages/schema", "docs"];
for (const d of dirs) {
  console.log(`${existsSync(join(process.cwd(), d)) ? "✓" : "✗"} ${d}`);
}

console.log("\nGate artifacts:");
const gateFiles = ["artifacts/gates/p0.json", "artifacts/gates/p1.json"];
for (const f of gateFiles) {
  console.log(`${existsSync(join(process.cwd(), f)) ? "✓" : "○"} ${f}`);
}

console.log("\nDoctor complete.");
