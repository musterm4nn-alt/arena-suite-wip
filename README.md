# Arena Model Archive

**Status:** P0-P1 implementation complete, architecture validated in mock mode
**Platform:** Apple Silicon macOS 14.0+, Electron 34.x arm64
**Primary interface:** Local MCP (stdio → Unix domain socket 0600)
**Capture strategy:** Passive CDP first, isolated-world UI witness second

Derived from `arena-model-archive-plan-ultimate.md` — agent-ready implementation plan.

## Architecture

```
UNTRUSTED REMOTE
  Arena WebContents A ─┐
  Arena WebContents B ─┼── CDP events / typed isolated-world observations ──► Electron Main
  workers / SW / OOPIF ┘                                                    │
                                                                             │
TRUSTED BROWSER CONTROL                                                      │
  Electron Main                                                              │
  - SessionManager      one account -> one session path                      │
  - CaptureSupervisor   CDP attach / target lifecycle / buffering            │
  - DownloadManager     account-bound staging and handoff                    │
  - Permission/Nav      no remote app privileges                             │
  - Key unwrap broker   transient only                                       │
                       │ typed MessagePort / local IPC
                       ▼
PRIVILEGED ARCHIVE SERVICE (utilityProcess)
  - SQLCipher single writer
  - observation journal + normalizer
  - protocol catalog / drift
  - sync scheduler / jobs
  - artifact sealing
  - export / deletion / backup
  - deterministic analysis
  - MCP service registry
                       │
               Unix domain socket 0600
                       │
                 stdio MCP bridge
                       │
                    LLM client
```

## Non-negotiable rules

1. Unknown remains unknown — missing data, model identity, endpoint semantics represented explicitly, never guessed
2. Account scope is part of identity — every observation, conversation, artifact, sync checkpoint keyed by stable local account_id + session epoch
3. Capture does not imply completeness — turn becomes complete only from positive terminal evidence and absence of observer gap
4. Remote content is data, never authority
5. Passive observation first
6. Evidence earns automation
7. One account failing must not degrade another
8. First implementation phase tries to break architecture

## Repository layout

```
arena-model-archive/
  apps/
    desktop/                 Electron bootstrap, windows, sessions, capture
    mcp-bridge/              tiny stdio <-> UDS relay
  packages/
    browser-adapter/         interface + Electron implementation
    capture-core/            event routing, assembly ledger, completeness
    protocol-catalog/        operation inventory, drift, adapters
    archive-service/         SQLCipher writer, queries, jobs
    schema/                  migrations + Zod boundary schemas
    sync/                    read qualification, pagination, checkpoints
    artifacts/               staging, encryption, MIME/hash handling
    security/                sanitizer, safe refs, directives
    mcp-contract/            tool schemas and service mapping
    analysis/                deterministic profiles + experiment framework
    fixtures/                synthetic/golden sanitized protocol fixtures
  docs/
    architecture-decisions/
    evidence-register.md
    platform.md
    threat-model.md
    capture-coverage.md
    protocol-catalog.md
  scripts/
    bootstrap-macos.sh
    doctor.ts
    gate-p0.ts
    gate-p1.ts
```

## Quick start (macOS)

```bash
./scripts/bootstrap-macos.sh
npm run build
npm run gate:p0   # hostile falsification spike — must pass before P1
npm run gate:p1   # smallest vertical slice
```

## P0 hostile spike (from plan)

- Assert attach/domain-enable occurs before first Arena navigation
- Exercise page, iframe, dedicated worker, shared worker, service-worker target creation; freeze/arm/resume
- Force navigation and renderer process loss during streams
- Split synthetic stream records at every UTF-8/logical boundary; replay duplicate chunks; overflow bounded queues
- Exercise streamed fetch, SSE, WebSocket, RSC-like payload, partial/stopped/failed outcomes and download start
- Run two accounts simultaneously with distinct storage/network sentinels
- Owner-session acceptance: email sign-in, one real streamed turn, one stop/failure, one navigation during stream, one reveal/vote workflow, one real artifact/download
- Compare evidence classes and gaps with existing exporter where practical

Decision: continue only if Electron shows materially stronger/reliable evidence with explicit gaps. If target coverage fails, test browser-level CDP. If body coverage fails, test proxy/tee. If required coverage still fails or requires semantic distortion, execute bounded CEF spike before building higher layers.

## MCP contract

Default transport: stdio bridge → Unix domain socket 0600. Optional Streamable HTTP on 127.0.0.1 with ephemeral port, bearer token, Host/Origin validation, no CORS, block Arena sessions from loopback.

Service domains: Accounts, Capture, Sync, Archive, Diagnostics, Analysis, Maintenance

Typed errors: E_SCOPE_MISMATCH, E_AUTH_EXPIRED, E_OWNER_ACTION_REQUIRED, E_RATE_LIMITED, E_CONFIRM_REQUIRED, E_LOCKED, E_DRIFT, E_UNSUPPORTED, E_PARTIAL, E_BUSY

GUI/MCP parity tested in CI by enumerating service commands. No essential workflow is GUI-only.

## Storage

- SQLCipher-compatible SQLite + FTS5
- Large artifacts encrypted individually AES-256-GCM with per-blob nonces
- Random archive key wrapped by macOS Keychain-backed storage
- Chromium partition dirs are NOT SQLCipher-protected — rely on FS perms + FileVault (explicit threat model)
- Artifact commit: stage → hash/MIME sniff → encrypt to temp sealed blob → fsync → atomic rename → DB commit → remove plaintext staging

## Analysis

v1 deterministic only — operates on immutable corpus snapshots identified by corpus hash + adapter/code/config versions, by default includes only complete turns whose model cohort is based on observed/revealed identity evidence.

Families: Structure, Lexical, Discourse, Interactive, Variation — every metric returns sample count and cohort definition, representative excerpts chosen deterministically and link back to provenance.

Fingerprinting/similarity gate: only after written question cannot be answered deterministically, with train/test separation, branch grouping, matched prompts, same-model/different-topic controls, unknown class calibration, pinned weights/seeds, predeclared stop criteria, negative results reported. Inference never mutates observed identity.

## License

Private — not for distribution
