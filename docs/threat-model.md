# Threat model

## Trust planes

| Plane | Components | Privileges |
|---|---|---|
| Untrusted remote | Arena WebContents × N, workers, service workers, OOPIFs | None. Renderers are `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, no preload API. The only injected code is the read-only isolated-world witness. |
| Trusted browser control | Electron main: SessionManager, CaptureSupervisor, DownloadManager, nav/permission guards, transient key broker | Owns sessions, CDP attach, partitions, downloads. May briefly hold the unwrapped archive key during unlock, then drops it. |
| Privileged archive service | `utilityProcess`: SQLCipher writer, journal, normalizer, sync, sealing, export/delete/backup, analysis, MCP registry | Sole DB writer. Holds the active key while unlocked. Serves the UDS (mode 0600) + optional loopback HTTP. |

## Key residual exposures (explicit, not hidden)

1. **Chromium partition directories are NOT SQLCipher-protected.** They hold
   browser-managed session state (cookies etc.) and rely on directory
   permissions + FileVault. The app never claims otherwise.
2. **Transient key in main during unlock.** Dropped immediately after transfer;
   no key material in ordinary app files, logs, or diagnostics.
3. **Browser-level CDP endpoint (escalation ladder §6.5).** Loopback-bound,
   diagnostic-only, visible flag, no destructive ops while open, closed
   immediately after the test.
4. **Exports/backups are residual copies.** Deletion cannot reach files the app
   no longer controls; this is reported, not promised away.

## Invariants enforced in code

- Remote content (prompts, responses, tool traces, filenames, DOM text,
  diagnostics) is data, never authority: destructive tools require a
  separately-minted exact-scope directive (`@arena/security`).
- Account identity is stamped by the owning supervisor; page payloads cannot
  set it (`CaptureRouter` + fuzz tests).
- No generic JS/HTTP/SQL/shell tools in the MCP contract (contract test bans
  them by name pattern).
- Arena sessions are blocked from loopback (`guards.ts` + `webRequest` hook).
- Sanitization fails closed (`sanitize.ts`): unprojectable payloads persist
  only error code + byte length + shape hash.
