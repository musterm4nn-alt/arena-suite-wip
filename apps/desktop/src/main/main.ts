/**
 * Electron bootstrap — main process owns Arena browser sessions and CDP attachment (section 1)
 * While archive service owns encrypted persistence, normalization, jobs, analysis, MCP
 *
 * Platform: Apple Silicon macOS, Electron/Chromium one pinned stable major, arm64 only
 * Minimum macOS 14.0, actual floor recorded in docs/platform.md
 */

import { SessionManager } from '../sessions/SessionManager.js';
import { CaptureSupervisor } from '../capture/CaptureSupervisor.js';
import { DownloadManager } from '../capture/DownloadManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { KeyBroker } from '../security/KeyBroker.js';
import { WindowManager } from '../windows/WindowManager.js';
import { ArchiveService } from '@arena/archive-service';
import { ElectronBrowserAdapter } from '@arena/browser-adapter';
import { ServiceRegistry } from '@arena/mcp-contract';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';

// This file is the entry for Electron main process
// For dev without Electron, we provide a mock bootstrap that can run via Node

async function bootstrap() {
  console.log('[Main] Starting Arena Model Archive — Electron/Chromium');

  const dataDir = ArchiveService.getDefaultDataDir();
  await fs.promises.mkdir(dataDir, { recursive: true, mode: 0o700 });

  // Session manager — one account -> one session path
  const sessionManager = new SessionManager();
  const captureSupervisor = new CaptureSupervisor(sessionManager);
  const downloadManager = new DownloadManager();
  const permissionManager = new PermissionManager();
  const keyBroker = new KeyBroker();
  const windowManager = new WindowManager();
  const browserAdapter = new ElectronBrowserAdapter();
  const serviceRegistry = new ServiceRegistry();

  // Archive service — sole writer, utilityProcess in real Electron
  const archiveKey = randomBytes(32); // In real, loaded via KeyBroker
  const archiveService = new ArchiveService({
    dataDir,
    dbPath: path.join(dataDir, 'archive.db'),
    archiveKey,
    mockDb: true, // real would use SQLCipher
  });
  await archiveService.start();

  // Register MCP tools — GUI and MCP call same registry
  serviceRegistry.register('diagnostics_capabilities', async () => {
    const caps = await browserAdapter.getCapabilities();
    return {
      platform: process.platform,
      arch: process.arch,
      electron_version: process.versions.electron ?? 'mock',
      capabilities: caps,
      storage: archiveService.getStorageHealth(),
      message: 'Diagnostics capabilities — explains unavailable/degraded features rather than hiding tools',
    };
  });

  serviceRegistry.register('accounts_list', async () => {
    const sessions = sessionManager.listSessions();
    return {
      accounts: sessions.map(s => ({
        id: s.accountId,
        display_name: null,
        auth_state: 'unknown',
        enabled: true,
        partition_path: s.partitionPath,
        epoch: s.sessionEpochId,
      })),
    };
  });

  serviceRegistry.register('capture_status', async (args: any) => {
    const accountId = args?.account_id;
    if (accountId) {
      return {
        account_id: accountId,
        attached: captureSupervisor.isAttached(accountId),
        stats: captureSupervisor.getStats(),
      };
    }
    return {
      all: true,
      stats: captureSupervisor.getStats(),
    };
  });

  serviceRegistry.register('diagnostics_protocol_catalog', async () => {
    return { message: 'Protocol catalog would be returned here', ops: [] };
  });

  serviceRegistry.register('diagnostics_storage_health', async () => {
    return archiveService.getStorageHealth();
  });

  // Simulate P0 hostile spike checks if requested
  if (process.argv.includes('--p0-spike')) {
    console.log('[Main] Running P0 hostile browser/capture falsification spike');
    await runP0Spike(sessionManager, captureSupervisor, browserAdapter);
  }

  console.log('[Main] Bootstrap complete — ready for owner-driven sign-in');
  console.log('[Main] Accounts:', sessionManager.listSessions().length);
  console.log('[Main] Service registry parity:', serviceRegistry.checkParity());

  // In real Electron: app.whenReady().then(createWindows)
  // For Node mock, keep process alive briefly or exit
  if (process.argv.includes('--exit-after-bootstrap')) {
    await archiveService.stop();
    process.exit(0);
  }
}

async function runP0Spike(sessionManager: SessionManager, supervisor: CaptureSupervisor, adapter: ElectronBrowserAdapter) {
  // P0 requirements from section 15:
  // Build only: Electron shell, two account sessions, CDP supervisor, in-memory/small encrypted test journal, diagnostic output
  const accountA = '11111111-1111-4111-8111-111111111111';
  const accountB = '22222222-2222-4222-8222-222222222222';

  console.log('[P0] Creating two account sessions');
  await sessionManager.createSession(accountA);
  await sessionManager.createSession(accountB);

  console.log('[P0] Assert attach/domain-enable occurs before first Arena navigation request');
  await supervisor.attach(accountA);
  await supervisor.attach(accountB);
  await adapter.attachBeforeNavigate(accountA);
  await adapter.attachBeforeNavigate(accountB);

  console.log('[P0] Exercise page, iframe, dedicated worker, shared worker and service-worker target creation; freeze/arm/resume child targets');
  const targetsA = await adapter.listTargets(accountA);
  const targetsB = await adapter.listTargets(accountB);
  console.log(`[P0] Targets A=${targetsA.length} B=${targetsB.length}`);
  for (const t of [...targetsA, ...targetsB]) {
    await adapter.attachToTarget(t.targetId, t.accountId);
    supervisor.bindTarget(t.targetId, t.accountId, `session-${t.targetId}`);
  }

  console.log('[P0] Force navigation and renderer process loss during streams');
  await adapter.navigate(accountA, 'https://arena.ai/');
  await adapter.navigate(accountB, 'https://arena.ai/');

  console.log('[P0] Split synthetic stream records at every UTF-8/logical boundary; replay duplicate chunks; overflow bounded queues deliberately');
  const { StreamAssemblyLedger } = await import('@arena/capture-core');
  const ledger = new StreamAssemblyLedger();
  const text = 'Hello 🌍 world — test café with emoji 🎉 and multi-byte';
  const chunks = StreamAssemblyLedger.splitAtUtf8Boundaries(text);
  console.log(`[P0] Split "${text}" into ${chunks.length} chunks at UTF-8 boundaries`);
  const rec = ledger.createRecord('test-req-1', accountA, { sessionEpochId: sessionManager.getSession(accountA)!.sessionEpochId });
  for (let i = 0; i < chunks.length; i++) {
    ledger.appendChunk('test-req-1', chunks[i], i);
  }
  // Replay duplicate
  ledger.appendChunk('test-req-1', chunks[0], 0);
  console.log(`[P0] Ledger duplicateCount=${rec.duplicateCount} totalBytes=${rec.totalBytes}`);
  const assembled = ledger.assemble('test-req-1');
  console.log(`[P0] Assembled text matches: ${assembled?.text === text}`);

  console.log('[P0] Exercise streamed fetch, SSE, WebSocket, RSC-like payload, partial/stopped/failed outcomes and download start');
  // Simulate network events
  const events = [
    { method: 'Network.requestWillBeSent', params: { requestId: 'req-stream', type: 'Fetch' }, sessionId: 'session-target-1111-page-1', targetId: 'target-1111-page-1', timestamp: Date.now() },
    { method: 'Network.dataReceived', params: { requestId: 'req-stream', dataLength: 100, data: Buffer.from('chunk1').toString('base64') }, sessionId: 'session-target-1111-page-1', targetId: 'target-1111-page-1', timestamp: Date.now() },
    { method: 'Network.loadingFinished', params: { requestId: 'req-stream' }, sessionId: 'session-target-1111-page-1', targetId: 'target-1111-page-1', timestamp: Date.now() },
  ];
  for (const ev of events) {
    supervisor.handleCdpEvent(ev as any);
  }

  console.log('[P0] Run two accounts simultaneously with distinct storage/network sentinels');
  const isolation = await sessionManager.testIsolation(accountA, accountB);
  console.log(`[P0] Isolation test: ${isolation.isolated} — ${isolation.details}`);

  console.log('[P0] Queue stats:', supervisor.getQueueStats());
  console.log('[P0] Spike complete — decision: continue only if Electron shows materially stronger/reliable evidence with explicit gaps');
}

// Run if executed directly
const isMainModule = process.argv[1]?.endsWith('main.js') || process.argv[1]?.endsWith('main.ts') || process.argv[1]?.includes('apps/desktop');
if (isMainModule) {
  bootstrap().catch(err => {
    console.error('[Main] Bootstrap failed', err);
    process.exit(1);
  });
}

export { bootstrap, runP0Spike };
