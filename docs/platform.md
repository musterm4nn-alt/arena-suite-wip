# Platform

- Primary runtime: Electron/Chromium pinned stable major, arm64 only
- Current pinned: Electron 32.3.3 (Chromium 128)
- Minimum macOS: 14.0 Sonoma
- Build floor note: If pinned Electron major's documented floor > 14.0, floor becomes that version. Electron 32 floor is macOS 10.15? Actually 11.0+ for recent. Documented as 11.0+, so our floor remains 14.0 as per plan.
- Architecture: x64 build allowed for CI/Linux testing, but release artifact is arm64 only (darwin-arm64)
- Node: >=20
- Package manager: npm workspaces

## Directories

- `~/Library/Application Support/ArenaArchive/` on macOS
  - `partitions/<account_uuid>/` — Chromium persistent session storage per account (cookies, IndexedDB, SW, etc.) — NOT SQLCipher-protected, relies on FileVault + FS perms
  - `archive/` — SQLCipher database + sealed blobs
  - `logs/` — structured logs (no secrets)
  - `backups/` — encrypted backup bundles

- On Linux (dev/CI): `~/.config/ArenaArchive/` fallback via Electron app.getPath('userData')

## Electron Fuses / Hardening

- `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false` for Arena WebContents
- No application preload exposing fs/db/key/MCP to Arena renderers
- Only isolated-world witness installed via CDP: worldName `arena-archive`
- `will-download` handled by DownloadManager, app-owned save path
- DevTools on Arena WebContents prohibited (would detach debugger). Separate diagnostics window uses own WebContents.

## Archive Service

- Runs as Electron utilityProcess (Node, no DOM)
- Single SQLite writer (SQLCipher-compatible)
- Communicates to main via MessagePort / typed IPC
- Owns key only while unlocked, transient unwrap from Keychain-backed storage

## MCP Bridge

- stdio <-> Unix domain socket (0600) by default
- Optional loopback HTTP on 127.0.0.1 ephemeral port, bearer token, Host/Origin validation, no CORS, block Arena sessions from loopback
