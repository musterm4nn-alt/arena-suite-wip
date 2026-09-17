/**
 * Electron main process — per §4 process and trust model
 * - SessionManager one account -> one session path
 * - CaptureSupervisor CDP attach / target lifecycle / buffering
 * - DownloadManager account-bound staging and handoff
 * - Permission/Nav no remote app privileges
 * - Key unwrap broker transient only
 */

import { SessionManager } from "./session-manager.js";
import { CaptureSupervisor } from "./capture-supervisor.js";
import { DownloadManager } from "./download-manager.js";
import { MockBrowserAdapter, ElectronBrowserAdapter } from "@arena-archive/browser-adapter";
import { ArchiveService } from "@arena-archive/archive-service";
import { ProtocolCatalog } from "@arena-archive/protocol-catalog";
import { ArtifactStore } from "@arena-archive/artifacts";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";

// Determine if running in Electron or Node (for CI)
const isElectron = !!process.versions.electron;

async function getAppSupportRoot(): Promise<string> {
  if (isElectron) {
    // @ts-ignore
    const { app } = await import("electron");
    return app.getPath("userData");
  }
  const base = process.env.ARENA_ARCHIVE_TEST_DIR || join(homedir(), ".config", "ArenaArchive");
  await mkdir(base, { recursive: true });
  return base;
}

async function main() {
  const appSupportRoot = await getAppSupportRoot();
  console.log(`[Main] appSupportRoot=${appSupportRoot} isElectron=${isElectron}`);

  const partitionsRoot = join(appSupportRoot, "partitions");
  const artifactsRoot = join(appSupportRoot, "artifacts");
  const dbPath = join(appSupportRoot, "archive", "archive.db");
  await mkdir(join(appSupportRoot, "archive"), { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  // Generate random 256-bit archive key per §11.1, wrapped by Keychain-backed storage
  // For P0, transient in memory
  const archiveKey = randomBytes(32).toString("hex");
  console.log(`[Main] archive key generated (transient, not persisted in plaintext)`);

  const sessionManager = new SessionManager(appSupportRoot);
  const archiveService = new ArchiveService({
    dbPath,
    partitionsRoot,
    artifactsRoot,
    encryptionKey: archiveKey,
  });
  const protocolCatalog = new ProtocolCatalog();
  const artifactStore = new ArtifactStore(artifactsRoot, archiveKey);
  const downloadManager = new DownloadManager(artifactStore);

  // Browser adapter selection: Electron primary, mock for CI
  const browserAdapter = isElectron ? new ElectronBrowserAdapter() : new MockBrowserAdapter();

  // For P0: create two account sessions
  const accountA = await sessionManager.createAccount();
  const accountB = await sessionManager.createAccount();

  console.log(`[Main] Created accounts A=${accountA.account_id} B=${accountB.account_id}`);

  // Capture supervisors per account
  const supervisorA = new CaptureSupervisor({
    accountId: accountA.account_id,
    sessionEpochId: accountA.session_epoch_id,
    partitionPath: accountA.partition_path,
    browserAdapter,
    archiveService,
    protocolCatalog,
  });

  const supervisorB = new CaptureSupervisor({
    accountId: accountB.account_id,
    sessionEpochId: accountB.session_epoch_id,
    partitionPath: accountB.partition_path,
    browserAdapter,
    archiveService,
    protocolCatalog,
  });

  // Attach-before-navigate
  const initA = await supervisorA.initialize();
  const initB = await supervisorB.initialize();

  console.log(`[Main] Supervisor A initialized wcId=${initA.webContentsId} orderingValid=${initA.orderingValid}`);
  console.log(`[Main] Supervisor B initialized wcId=${initB.webContentsId} orderingValid=${initB.orderingValid}`);

  // Verify isolation
  const isolation = await sessionManager.verifyIsolation(accountA.account_id, accountB.account_id);
  console.log(`[Main] Isolation check A/B: ${JSON.stringify(isolation)}`);

  // Write sentinels for blocking test
  await sessionManager.writeSentinel(accountA.account_id, "test", `sentinel-A-${accountA.account_id}`);
  await sessionManager.writeSentinel(accountB.account_id, "test", `sentinel-B-${accountB.account_id}`);

  // Navigate
  await supervisorA.navigateToArena();
  await supervisorB.navigateToArena();

  // For P0: exercise target matrix
  const matrix = await browserAdapter.getTargetMatrix();
  console.log(`[Main] Target matrix: ${JSON.stringify(matrix)}`);

  // Exercise streamed fetch, SSE, WebSocket, RSC-like payload, partial/stopped/failed, download start
  // Simulated via supervisor processing already

  // Force navigation during stream and crash injection
  await supervisorA.forceNavigationDuringStream("https://arena.ai/other");
  await supervisorB.simulateCrash();

  // Metrics
  console.log(`[Main] Queue A metrics: ${JSON.stringify(supervisorA.getQueueMetrics())}`);
  console.log(`[Main] Queue B metrics: ${JSON.stringify(supervisorB.getQueueMetrics())}`);
  console.log(`[Main] Ledger A metrics: ${JSON.stringify(supervisorA.getLedgerMetrics())}`);
  console.log(`[Main] Archive metrics: ${JSON.stringify(archiveService.getMetrics())}`);
  console.log(`[Main] Protocol ops: ${protocolCatalog.getOps().length} drift: ${protocolCatalog.getDriftEvents().length}`);

  // Integrity check
  await archiveService.integrityCheck();

  // For Electron: create diagnostics window, not DevTools on Arena WebContents per spec
  if (isElectron) {
    const { BrowserWindow } = await import("electron");
    const { renderDiagnosticsHtml } = await import("./diagnostics-window.js");
    const diagWin = new BrowserWindow({
      width: 1200,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
      title: "Arena Archive Diagnostics",
    });
    const html = renderDiagnosticsHtml({
      accounts: [
        { id: accountA.account_id, partition_path: accountA.partition_path, epoch: accountA.session_epoch_id },
        { id: accountB.account_id, partition_path: accountB.partition_path, epoch: accountB.session_epoch_id },
      ],
      target_matrix: matrix,
      attach_ordering: await browserAdapter.getAttachOrderingProof(),
      archive_metrics: archiveService.getMetrics(),
      protocol_ops: protocolCatalog.getOps().length,
      drift_events: protocolCatalog.getDriftEvents().length,
      queue_metrics: supervisorA.getQueueMetrics(),
      ledger_metrics: supervisorA.getLedgerMetrics(),
    });
    await diagWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }

  console.log("[Main] P0 initialization complete. Ready for gate tests.");

  // Keep process alive in Electron, exit in Node test
  if (!isElectron) {
    // Cleanup
    await supervisorA.destroy();
    await supervisorB.destroy();
    console.log("[Main] Non-Electron run complete, exiting");
    process.exit(0);
  }
}

// Electron lifecycle
if (isElectron) {
  (async () => {
    const { app } = await import("electron");
    await app.whenReady();
    await main();
    app.on("window-all-closed", () => {
      // Keep alive? For P0 we quit when diagnostics closed
      app.quit();
    });
  })();
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
