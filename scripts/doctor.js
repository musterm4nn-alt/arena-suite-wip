"use strict";
/**
 * Doctor — checks platform, dependencies, and architecture compliance
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const os = __importStar(require("node:os"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
async function main() {
    console.log('=== Arena Archive Doctor ===');
    console.log(`Platform: ${process.platform} ${os.release()} arch=${process.arch} node=${process.version}`);
    console.log(`CWD: ${process.cwd()}`);
    const checks = [];
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
    }
    catch (e) {
        checks.push({ name: 'electron_pinned', ok: false, details: `Failed to read package.json: ${e.message}` });
    }
    // macOS version check
    if (process.platform === 'darwin') {
        const release = os.release(); // Darwin kernel version
        checks.push({ name: 'macos', ok: true, details: `macOS Darwin ${release} — minimum 14.0 per plan, actual floor is Electron 34's floor if later` });
    }
    else {
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
    }
    catch (e) {
        checks.push({ name: 'data_dir_perms', ok: false, details: `Failed to create data dir: ${e.message}` });
    }
    // TypeScript build
    try {
        await fs.promises.access('packages/schema/dist/index.js');
        checks.push({ name: 'build', ok: true, details: 'TypeScript build artifacts exist' });
    }
    catch {
        checks.push({ name: 'build', ok: false, details: 'Build artifacts missing — run npm run build' });
    }
    // Gate artifacts dir
    try {
        await fs.promises.mkdir('artifacts/gates', { recursive: true });
        checks.push({ name: 'gate_dir', ok: true, details: 'artifacts/gates exists' });
    }
    catch (e) {
        checks.push({ name: 'gate_dir', ok: false, details: e.message });
    }
    console.log('\nChecks:');
    for (const c of checks) {
        console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.details}`);
    }
    const failed = checks.filter(c => !c.ok);
    if (failed.length > 0) {
        console.log(`\n${failed.length} check(s) failed — see above`);
    }
    else {
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
//# sourceMappingURL=doctor.js.map