# ADR-0001: Electron as primary capture shell, CEF as gated escalation

- **Status:** accepted (from master plan §3)
- **Context:** Need out-of-band capture (bodies/streams/WS/SSE), per-account
  isolation, artifact control, and agent-maintainable stack on Apple Silicon.
- **Decision:** Electron/Chromium pinned stable major, arm64, TypeScript.
  Core services depend only on the `@arena/browser-adapter` interface.
- **Escalation:** If P0 proves a required observation class unobtainable
  without semantic distortion, replace ONLY the adapter with CEF (native
  response filters). Storage/identity/MCP/sync/analysis do not change.
- **Consequences:** Pinned-major maintenance; native SQLCipher binding risk on
  upgrades (build/boot gate); DevTools-on-Arena prohibition (detach hazard).
