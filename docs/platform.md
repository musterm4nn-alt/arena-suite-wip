# Platform

- **Target:** Apple Silicon macOS (`darwin/arm64`) only.
- **Minimum macOS:** 14.0, unless the pinned Electron major documents a later
  floor — in which case the later floor wins and is recorded here.
- **Pinned runtime:** Electron `^36` (see `apps/desktop/package.json`).
  Electron 36's documented minimum is macOS 11, so the app floor stays **14.0**.
  Re-verify with `npm run doctor` after any Electron major bump.
- **Language:** TypeScript throughout (main, archive service, MCP bridge,
  adapters, tests, deterministic analysis). No Swift/Rust/C++ in v1 scope.
- **Persistence:** SQLCipher-compatible SQLite + FTS5 (production binding is
  selected in P1; P0 uses the in-memory driver behind the same interface).
- **Key storage:** macOS Keychain-backed wrapping (`StubKeyBroker` is test-only
  and refuses to run without `ARENA_ALLOW_STUB_KEYS=1`).

## Development on other platforms

`capture-core`, `security`, `protocol-catalog`, `sync`, `analysis`,
`archive-service` (memory driver), and the P0 gate run anywhere Node 20+
runs. Only `apps/desktop` (Electron shell) requires macOS + the Electron
binary. CI runs `tsc -b`, `vitest run`, and `gate:p0` on both Linux and
macOS; the Electron binary download is skipped on Linux
(`ELECTRON_SKIP_BINARY_DOWNLOAD=1`, types only).
