/**
 * Electron main entry — the ONLY file that touches the real `electron` module.
 * Never executed in this sandbox (no arm64 macOS runtime); the headless stack
 * shares every service with it, so gate results transfer except where the
 * evidence register says otherwise.
 */
export const MAIN_ENTRY = 'apps/desktop/src/main.ts';

export async function bootstrap(): Promise<void> {
  const { app } = await import('electron');
  const { app: _app } = { app } as const;
  void _app;
  // 1. app.whenReady -> create diagnostics window + key unlock broker
  // 2. SessionManager: one persistent partition per account id (§5)
  // 3. CaptureSupervisor.openAccountView for each enabled account (§6.1)
  // 4. ArchiveService over UDS with mcp-contract tool table (§12)
  // 5. DownloadManager: will-download -> ArtifactStore.seal (§10.3)
  // The renderer for Arena views has NO preload API by construction.
  throw new Error('Electron bootstrap runs only in the packaged macOS app; see docs/platform.md');
}
