/**
 * Electron main bootstrap (plan §4).
 *
 * Main owns Arena sessions + CDP attachment; the archive service
 * (utilityProcess) owns encrypted persistence, jobs, and MCP. This file wires
 * the two and enforces the trust model. P0: shell + two sessions + capture
 * harness; full DB/MCP wiring lands in P1.
 */
import * as path from "node:path";
import { SessionManager } from "./sessions.js";
import { CaptureSupervisor } from "./supervisor.js";
import { allowNewWindow, arenaWebPreferences, diagnosticsWebPreferences, isLoopbackUrl } from "./guards.js";
import { safeLeafName, stagingDir } from "./downloads.js";
import { ElectronBrowserAdapter } from "./electron-adapter.js";

const ARENA_URL = "https://arena.ai/";

interface ArenaAppDeps {
  userDataPath: string;
  diagnosticsPreload: string;
  diagnosticsHtml: string;
}

/** Pure wiring plan (unit-testable without Electron). */
export function planStartup(accountIds: string[], deps: ArenaAppDeps) {
  const sessions = new SessionManager(deps.userDataPath);
  for (const id of accountIds) sessions.register(id);
  const supervisors = new Map<string, CaptureSupervisor>();
  for (const id of accountIds) {
    supervisors.set(id, new CaptureSupervisor({ accountId: id, epochId: null }));
  }
  return { sessions, supervisors };
}

async function bootElectron(): Promise<void> {
  const { app, BrowserWindow, session, utilityProcess } = await import("electron");

  await app.whenReady();
  const userData = app.getPath("userData");
  const sessions = new SessionManager(userData);
  const adapter = new ElectronBrowserAdapter();

  // Account list comes from the archive service in P1; P0 uses env-provided UUIDs.
  const accountIds = (process.env["ARENA_ACCOUNTS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of accountIds) sessions.register(id);

  // Archive service as utilityProcess (P1 full wiring; P0 placeholder path).
  void utilityProcess;

  // Downloads: account-bound staging before any linkage (plan §5).
  for (const rec of sessions.list()) {
    const ses = session.fromPartition(sessions.partitionFor(rec.accountId));
    ses.on("will-download", (_event, item) => {
      const dir = stagingDir(userData, rec.accountId);
      const leaf = safeLeafName(item.getFilename());
      item.setSavePath(path.join(dir, `${Date.now()}-${leaf}`));
    });
    // Block Arena sessions from loopback (MCP HTTP guard).
    ses.webRequest.onBeforeRequest((details, cb) => {
      if (isLoopbackUrl(details.url)) return cb({ cancel: true });
      cb({});
    });
  }

  // Diagnostics window (local origin, strict CSP, narrow bridge).
  const diag = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: diagnosticsWebPreferences(
      path.join(app.getAppPath(), "dist/preload/diagnostics-preload.js"),
    ) as never,
  });
  await diag.loadFile(path.join(app.getAppPath(), "windows/diagnostics.html"));

  // Arena views attach via the adapter; hidden until owner sign-in (P1 shows them).
  for (const rec of sessions.list()) {
    const s = await adapter.createSession(rec.accountId, sessions.storagePathFor(rec.accountId));
    s.onEvent((evt) => {
      void evt; // P1: route into CaptureSupervisor -> archive service IPC.
    });
    await s.attach(ARENA_URL);
  }

  // Popup policy: same-partition https only.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) =>
      allowNewWindow(url) ? { action: "allow" } : { action: "deny" },
    );
    void arenaWebPreferences;
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

const isElectronRuntime =
  typeof process !== "undefined" &&
  (process as unknown as { versions?: { electron?: string } }).versions?.electron !== undefined;

if (isElectronRuntime) {
  bootElectron().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("fatal:", err);
    process.exit(1);
  });
}
