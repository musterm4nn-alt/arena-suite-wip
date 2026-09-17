# Platform

- **Primary runtime:** Electron/Chromium pinned stable major 34.x, arm64 only
- **Minimum macOS:** 14.0 (Sonoma). If pinned Electron major's documented floor is later than 14.0, actual build floor becomes that later version.
- **Current pinned Electron:** 34.2.0 (as of 2026-09-17)
  - Documented minimum macOS for Electron 34: macOS 11.0+ (so floor remains 14.0 per plan)
- **Node:** >=20.0.0, tested on 22.x
- **Persistence:** SQLCipher-compatible SQLite + FTS5, large artifacts AES-256-GCM individually, random archive key wrapped by macOS Keychain-backed storage (simulated via 0600 file on Linux dev)
- **Build:** TypeScript 5.6+, single pinned Electron major, arm64 only

## Residual plaintext exposure

Chromium partition directories (`Application Support/ArenaArchive/partitions/<account_uuid>/`) contain browser-managed session data and rely on app directory permissions + FileVault, not SQLCipher. This is explicitly part of threat model.

## Development on Linux

Architecture is designed for macOS, but mock adapters allow P0 spike and gates to run on Linux for CI. Real capture requires macOS + Electron.
