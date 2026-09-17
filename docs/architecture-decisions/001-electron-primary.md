# ADR 001 — Electron as Primary Runtime

**Status:** Accepted
**Date:** 2026-09-17
**Context:** §3 Architecture selection — eligible candidates: Swift+WKWebView, Tauri/Wry, Electron/Chromium, CEF, Extension+native host, Export/import only.

**Decision:** Select Electron/Chromium, one pinned stable major, arm64 only, TypeScript for main, archive service, MCP bridge, adapters, tests, analysis.

**Rationale:**
- Electron exposes CDP Network/Target/Runtime, bodies/chunks, WS, EventSource, early target control — decisive for capture depth.
- First-class persistent sessions with explicit per-account directories.
- `will-download` direct save path and app-owned encryption.
- Best agent maintainability: TypeScript, mainstream docs, prebuilt arm64 runtime.
- Controls session creation, target attachment timing, partition identity, downloads, target lifecycle, account-bound requests before Arena navigation.

**Alternatives considered:**
- Swift+WKWebView: insufficient public HTTPS body/stream visibility.
- Tauri/Wry: inherits WKWebView capture limitation on macOS.
- CEF: excellent native interception ceiling but higher C++/CMake/helper/signing burden — keep as browser-adapter escalation if Electron cannot observe required class reliably.
- Extension+native host: retains extension lifecycle/attachment/bridge complexity.
- Export/import only: no live capture.

**Consequences:**
- Must handle DevTools detach hazard (DevTools on Arena WebContents prohibited).
- Must implement attach-before-navigate protocol.
- Partition dirs are residual plaintext/browser-managed, protected by FS perms + FileVault, not SQLCipher — explicitly documented.
- CEF adapter remains replaceable via BrowserAdapter interface.

**Falsification gate:** P0 must prove Electron shows materially stronger/reliable evidence with explicit gaps. If target coverage fails, test browser-level CDP. If body coverage fails, test proxy/tee. If still fails, bounded CEF spike.
