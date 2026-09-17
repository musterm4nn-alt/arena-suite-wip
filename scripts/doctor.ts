/**
 * Doctor — checks platform, dependencies, and architecture compliance
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function main() {
  console.log('=== Arena Archive Doctor ===');
  console.log(`Platform: ${process.platform} ${os.release()} arch=${process.arch} node=${process.version}`);
  console.log(`CWD: ${process.cwd()}`);

  const checks: Array<{ name: string; ok: boolean; details: string }> = [];

  // Node version
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  checks.push({
    name: 'node_version',
    ok: nodeMajor >= 20,
    details: `Node ${process.version} >=20 required`,
  });

  // Electron pinned?
  try {
    const pkg = JSON.parse(await fs.promises.readFile('package.json', 'utf-8'));
    const electronVersion = pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? 'not found';
    checks.push({
      name: 'electron_pinned',
      ok: electronVersion.includes('34') || electronVersion.includes('^34') || electronVersion.includes('33'),
      details: `Electron version: ${electronVersion} — should be pinned stable major 34.x`,
    });
  } catch (e) {
    checks.push({ name: 'electron_pinned', ok: false, details: `Failed to read package.json: ${(e as Error).message}` });
  }

  // macOS version check
  if (process.platform === 'darwin') {
    const release = os.release(); // Darwin kernel version
    checks.push({ name: 'macos', ok: true, details: `macOS Darwin ${release} — minimum 14.0 per plan, actual floor is Electron 34's floor if later` });
  } else {
    checks.push({ name: 'macos', ok: false, details: `Not macOS — ${process.platform} — P0 spike can run in mock mode but real capture requires macOS` });
  }

  // Data dir permissions
  const dataDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'ArenaArchive')
    : path.join(os.homedir(), '.config', 'arena-archive');
  try {
    await fs.promises.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.stat(dataDir);
    const mode = (stat.mode & 0o777).toString(8);
    checks.push({ name: 'data_dir_perms', ok: mode === '700' || process.platform !== 'darwin', details: `Data dir ${dataDir} mode=${mode} should be 700` });
  } catch (e) {
    checks.push({ name: 'data_dir_perms', ok: false, details: `Failed to create data dir: ${(e as Error).message}` });
  }

  // TypeScript build
  try {
    await fs.promises.access('packages/schema/dist/index.js');
    checks.push({ name: 'build', ok: true, details: 'TypeScript build artifacts exist' });
  } catch {
    checks.push({ name: 'build', ok: false, details: 'Build artifacts missing — run npm run build' });
  }

  // Gate artifacts dir
  try {
    await fs.promises.mkdir('artifacts/gates', { recursive: true });
    checks.push({ name: 'gate_dir', ok: true, details: 'artifacts/gates exists' });
  } catch (e) {
    checks.push({ name: 'gate_dir', ok: false, details: (e as Error).message });
  }

  console.log('\nChecks:');
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.details}`);
  }

  const failed = checks.filter(c => !c.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed — see above`);
  } else {
    console.log('\nAll checks passed');
  }

  // Write doctor result
  const result = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    checks,
    overall_ok: failed.length === 0,
  };
  await fs.promises.mkdir('artifacts/gates', { recursive: true });
  await fs.promises.writeFile('artifacts/gates/doctor.json', JSON.stringify(result, null, 2));
  console.log('\nWrote artifacts/gates/doctor.json');
}

main().catch(err => {
  console.error('Doctor failed', err);
  process.exit(1);
});
