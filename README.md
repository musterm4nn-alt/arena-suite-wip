# Arena Model Archive — P0/P1 Implementation

Private Apple-Silicon Electron application whose main process owns Arena browser sessions and CDP attachment, while a separate archive service owns encrypted persistence, normalization, jobs, analysis, and MCP.

- **Primary architecture:** Electron / Chromium + TypeScript
- **Primary interface:** Local MCP (stdio <-> UDS 0600, optional loopback HTTP)
- **Capture strategy:** Passive CDP first, isolated-world UI witness second
- **Fallback:** CEF only if falsification gates prove Electron insufficient

This repo implements the Ultimate Synthesized Architecture Plan (`arena-model-archive-plan-ultimate.md`).

## Repository Layout (per §17)

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

## Process and Trust Model (per §4)

- Arena renderers: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, no preload API, no fs/db/key/MCP access. Only isolated-world witness via CDP.
- Diagnostics GUI: local app origin, strict CSP, narrow bridge. GUI and MCP call same typed service registry.
- Archive service: sole DB writer, utilityProcess, owns key only while unlocked, transient unwrap via Keychain.

## Simultaneous Account Isolation (per §5)

- One account = immutable local UUID, one persistent Session with explicit storage dir `partitions/<uuid>/`
- Never derive paths from email/display name/model label/page data
- Blocking tests: sentinel cross-read, fuzz page-supplied account_id, sign-out A while B streams, etc.

## Live Capture (per §6)

Attach-before-navigate protocol:

```
create account WebContents with NO Arena URL loaded
bind WebContents -> account_id
create bounded capture queue
debugger.attach()
Network.enable, Page.enable, Runtime.enable, Runtime.addBinding isolated-world only
Page.addScriptToEvaluateOnNewDocument(readOnlyWitness, worldName="arena-archive")
Target.setAutoAttach flatten=true waitForDebuggerOnStart=true
verify acks
ONLY THEN navigate to https://arena.ai/
```

- Primary witness: passive CDP Network events, streamResourceContent early, WebSocket/ES independently
- Assembly ledger: monotonic chunk seq, byte length, hash, duplicate count, timestamps, terminal signals, gap intervals
- Rendered-state witness: only UI facts unavailable in network, typed via binding, versioned selector adapters with drift counters
- No SW bypass in production by default

## P0 Gate — Hostile Falsification Spike

Build only: Electron shell, two account sessions, CDP supervisor, in-memory/small encrypted journal, diagnostic output.

Checklist:
- [x] Assert attach/domain-enable occurs before first Arena navigation
- [x] Exercise page, iframe, dedicated worker, shared worker, service-worker target creation; freeze/arm/resume
- [x] Force navigation and renderer crash during streams
- [x] Split synthetic stream records at every UTF-8/logical boundary; replay duplicates; overflow bounded queues
- [x] Exercise streamed fetch, SSE, WebSocket, RSC-like, partial/stopped/failed, download start
- [x] Two accounts simultaneously with distinct sentinels
- [ ] Owner-session acceptance (requires real Arena account, manual)

Run:
```
npm install
npm run gate:p0
```

Produces `artifacts/gates/p0.json` with test version, runtime versions, passed/failed, measured facts, explicit falsifiers.

Decision: continue only if Electron shows materially stronger/reliable evidence with explicit gaps. If target coverage fails -> browser-level CDP diagnostic, if body coverage fails -> proxy/tee experiment, if still fails -> bounded CEF spike.

## P1 Gate — Smallest Vertical Slice

One account, one complete stream, one crash-during-stream producing partial_stream, SQLCipher observation+normalized records, transcript query through MCP, provenance lookup, scratch deletion with directive. Proves browser -> sanitizer -> storage -> transcript -> MCP.

```
npm run gate:p1
```

## Security (per §11)

- Sanitization before persistence: drop Authorization, Cookie, Set-Cookie, passwords, MFA codes, OAuth codes, CSRF tokens, bearer strings, secret signed-URL params. Safe URL ref: `{host,path,query_key_set,query_hash,expiry_class}`
- Encryption: random 256-bit archive key, wrapped by Keychain, SQLCipher DB, AES-256-GCM per-blob with nonce + authenticated metadata
- Partition dirs are residual plaintext/browser-managed, protected by FS perms + FileVault, not SQLCipher — explicitly documented
- Destructive-action guard: MCP cannot mint approval, trusted GUI/CLI mints random single-use short-lived directive with scope hash, tool must supply matching args, mismatch/expiry/replay -> E_CONFIRM_REQUIRED

## MCP Contract (per §12)

- Default transport: stdio bridge <-> UDS 0600
- Optional loopback HTTP 127.0.0.1 ephemeral port, bearer token, Host/Origin validation, no CORS, block Arena sessions from loopback
- Domains: Accounts, Capture, Sync, Archive, Diagnostics, Analysis, Maintenance
- Typed errors: E_SCOPE_MISMATCH, E_AUTH_EXPIRED, E_OWNER_ACTION_REQUIRED, E_RATE_LIMITED, E_CONFIRM_REQUIRED, E_LOCKED, E_DRIFT, E_UNSUPPORTED, E_PARTIAL, E_BUSY
- No generic JS/HTTP/SQL/shell tools

## Analysis (per §13)

Deterministic v1: operates on immutable corpus snapshots identified by corpus hash + adapter/code/config versions. By default only complete turns whose model cohort based on observed/revealed identity.

Families: Structure, Lexical, Discourse, Interactive, Variation. Every metric returns sample count and cohort definition. Representative excerpts chosen deterministically, link back to provenance.

Fingerprinting/similarity gate: only after written question cannot be answered deterministically, with conversation-level train/test separation, keep branches together, include controls, calibrate unknown class, pin seeds, predeclare stop criteria, report negative results. Inference output never mutates observed identity.

## Roadmap (per §14)

1. Search + citations
2. Code / web outputs
3. Images
4. Video/workflows
5. Agent sessions
6. Uploads/derived artifacts

## Implementation Sequence (per §15)

No calendar estimates. Each phase earned by evidence.

- P0 Hostile falsification spike (this)
- P1 Smallest vertical slice (this)
- P2 Complete text capture
- P3 Multi-account trust and storage integrity
- P4 Backfill qualification and synchronization
- P5 Agent-operation parity
- P6 Heavy-use measurement and text-v1 release
- P7 Deterministic analysis

## Running

```bash
npm install
npm run doctor
npm run gate:p0
npm run gate:p1
npm run build
# Electron (on macOS):
npm run dev --workspace=apps/desktop
```

## Threat Model & Platform

See `docs/threat-model.md` and `docs/platform.md`.
