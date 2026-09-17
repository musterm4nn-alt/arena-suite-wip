# ADR 001: Electron as primary runtime

- **Status:** Accepted
- **Context:** Need out-of-band capture, account isolation, artifacts, agent maintainability. Candidates: Swift+WKWebView, Tauri/Wry, Electron/Chromium, CEF, Extension+native host, Export/import only.
- **Decision:** Electron/Chromium, one pinned stable major, arm64 only. TypeScript for main, archive service, MCP bridge, adapters, tests, deterministic analysis.
- **Consequences:** Best TypeScript mainstream docs, prebuilt arm64 runtime, CDP Network/Target/Runtime, bodies/chunks, WS, EventSource, early target control, first-class persistent sessions, explicit per-account directories, will-download direct save path and app-owned encryption. CEF kept as browser-adapter escalation if Electron cannot observe required class reliably.
- **Validation:** P0 hostile falsification spike must show materially stronger/reliable evidence with explicit gaps vs extension baseline.
