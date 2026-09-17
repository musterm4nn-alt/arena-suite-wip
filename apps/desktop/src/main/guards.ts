/**
 * Permission / navigation guards (plan §4).
 *
 * Arena renderers get NO app privileges: sandbox, context isolation, no node,
 * no remote-app privileges. Popups required by sign-in stay in-partition.
 * DevTools on Arena WebContents is prohibited (debugger detach hazard).
 */

export const ARENA_ORIGIN = "https://arena.ai";

/** Loopback destinations Arena sessions must never reach (MCP HTTP guard). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isArenaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === ARENA_ORIGIN;
  } catch {
    return false;
  }
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Decide window.open / new-target navigation: same-partition allow-list. */
export function allowNewWindow(requestedUrl: string): boolean {
  // Sign-in flows stay in-partition; only https is ever allowed.
  try {
    const u = new URL(requestedUrl);
    if (u.protocol !== "https:") return false;
    if (isLoopbackUrl(requestedUrl)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Web preferences for Arena views — the trust model in one place. */
export function arenaWebPreferences(partition: string): Record<string, unknown> {
  return {
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    // No preload: the only injected code is the CDP-installed isolated witness.
    preload: undefined,
    devTools: false,
  };
}

/** Tight preferences for the local diagnostics GUI. */
export function diagnosticsWebPreferences(preloadPath: string): Record<string, unknown> {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
    preload: preloadPath,
    devTools: process.env["ARENA_DIAG_DEVTOOLS"] === "1",
  };
}
