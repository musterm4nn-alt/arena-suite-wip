# Implementation Status

## P0 — Hostile browser/capture falsification spike

**Status:** ✅ Complete (mock + Electron structure)

**Artifacts:** `artifacts/gates/p0.json`

**Implemented:**
- Electron shell with SessionManager (one account -> one session path, explicit storage dir, never derived from email)
- MockBrowserAdapter + ElectronBrowserAdapter with attach-before-navigate protocol
- CaptureSupervisor: debugger.attach(), Network.enable, Page.enable, Runtime.enable, addBinding isolated-world only, Page.addScriptToEvaluateOnNewDocument witness, Target.setAutoAttach flatten=true waitForDebuggerOnStart=true, verify acks, ONLY THEN navigate
- BoundedQueue with overflow handling and metrics
- StreamAssemblyLedger with monotonic seq, byte length, hash, duplicate count, gap intervals, UTF-8 boundary splitting, duplicate replay
- Target matrix: page, iframe, dedicated worker, shared worker, service worker — exercised via attachedToTarget simulation
- Force navigation and renderer crash during streams -> observer_gap / partial_stream evidence
- Transport coverage: chunked, sse, websocket, rsc, json (via golden fixtures)
- Download start via DownloadManager + ArtifactStore (stage -> hash/MIME sniff -> encrypt -> fsync -> rename -> DB commit -> remove staging)
- Dual-account isolation: distinct partition paths, session partitions, sentinel write test, account_id stamping authority (supervisor-derived wins)
- Protocol catalog inventory + drift counters
- Diagnostics window separate from Arena WebContents (DevTools on Arena prohibited)

**Measured facts in p0.json:**
- attachTimestamp < firstRequestTimestamp orderingValid true
- target matrix all true (mock; real Electron needs owner-session verification for SW/shared worker)
- UTF-8 boundary tests 7/7 passed
- duplicate handling 2 duplicates counted, not double-appended
- queue overflow 5 enqueued, 15 dropped as expected
- transports observed: chunked, rsc, sse, websocket
- decision: continue (no critical failures)

**Explicit falsifiers:** none in mock; real run would document gaps like shared_worker needs browser-level CDP fallback if not seen via WebContents debugger.

**Fallback ladder readiness:**
- Browser-level CDP diagnostic flag ready (temporary loopback endpoint, visible state, no destructive ops)
- Proxy/tee experiment gated (must prove semantics identical)
- CEF BrowserAdapter interface ready (native filters, keep core services unchanged)

## P1 — Smallest vertical slice

**Status:** ✅ Complete

**Artifacts:** `artifacts/gates/p1.json`

**Proves:** browser -> sanitizer -> storage -> transcript -> MCP

**Implemented:**
- One account, one complete stream (observation + normalized turn)
- One crash-during-stream producing partial_stream
- SQLCipher observation+normalized records (in-memory for P0, schema migrations ready for SQLCipher)
- Transcript query via archive_search (FTS5 placeholder, substring search for P1)
- Provenance lookup (observation_ids -> observations)
- Scratch deletion with directive (createDeleteDirective, verifyDirective, single-use short-lived, scope hash, E_CONFIRM_REQUIRED on mismatch/expiry/replay)

## P2 — Complete text capture (planned)

**Goals:**
- Battle, Direct, Side-by-Side
- completed/stopped/failed/partial
- branches/regenerations
- late model identity (reveal vs selected label vs blind label, append-only identity_claims, resolved identity is view)
- history-opened conversations
- worker/SW coverage
- UI/network reconciliation
- downloads linked when available
- Golden fixtures and property tests vary chunk boundaries/order/duplicates

**Status:** Scaffolded — fixtures exist, assembly ledger and completeness model implemented, witness ready, protocol catalog ready. Needs real Arena session.

## P3 — Multi-account trust and storage integrity (planned)

**Goals:**
- Two live accounts across restart
- Cross-account collision tests (sentinel + fuzz account_id)
- Auth expiry and identity rebind tests
- Secret canaries through success/error paths (sanitizeHeaders, toSafeUrlRef, sanitizeJsonPayload, failClosed)
- Disk-full and crash injection
- Migration backup/restore (encrypted bundle + manifest verification)
- Artifact sealing and plaintext staging cleanup

**Status:** SessionManager isolation and security canaries implemented, backup/restore scaffolded, artifact store implements sealing protocol.

## P4 — Backfill qualification and synchronization (planned)

**Goals:**
- Read probes (7 steps per §9.1: session epoch + identity probe, observe op, fingerprint before replay, same-session request, fingerprint after, pagination boundary, detail cross-check, record probe, drift invalidates)
- Stable pagination/detail cross-check
- Interruption/resume with checkpoint chain (cursor, page_fingerprint, seen_set_digest, counts, adapter version, run_sequence, transactional commit)
- Overlap/re-run idempotent upsert inside account scope
- Concurrent accounts, live-capture overlap (do not overwrite in-flight live turn, reconcile after close)
- Challenge/rate-limit/drift behavior (pause only affected account)
- Coverage report per §9.3

**Status:** SyncScheduler scaffolded with probe logic, checkpoint, coverage report.

## P5 — Agent-operation parity

**Goals:**
- Scripted MCP client exercises every GUI service
- Malicious archived text requests destructive actions and must fail without separately minted exact-scope directive
- No generic execution escape hatches (no arbitrary JS/HTTP/SQL/shell tools)
- GUI/MCP parity tested in CI by enumerating service commands

**Status:** mcp-contract defines all tools, mcp-bridge implements stdio<->UDS 0600, optional HTTP with bearer+Host/Origin validation, service registry scaffolded, typed errors defined.

## P6 — Heavy-use measurement and text-v1 release

**Goals:**
- Measure process-tree memory, macOS memory pressure/swap deltas, CPU, queue high-water marks, capture lag, DB growth/query latency, artifact throughput, sync rate on M3 Pro 18GB
- Set quotas from observations
- Under pressure, reduce sync/analysis/tab concurrency before sacrificing capture correctness

**Status:** Queue metrics, ledger metrics, archive metrics implemented; resource diagnostics planned.

## P7 — Deterministic analysis

**Goals:**
- Golden feature tests, corpus hashes, cohort/missingness reports, offline operation, representative excerpts
- Analysis families: Structure, Lexical, Discourse, Interactive, Variation
- Fingerprinting/similarity gate: conversation-level train/test separation, keep branches together, controls, unknown class calibrated, seeds pinned, stop criteria predeclared, negative results reported
- Inference output never mutates observed identity

**Status:** analysis package implements corpus snapshot, structure/lexical/discourse/interactive metrics, deterministic excerpts, fingerprint gate validation.

## Overall

- Repository layout per §17 implemented
- Docs: platform, threat-model, capture-coverage, protocol-catalog, evidence-register, architecture-decisions
- Scripts: bootstrap-macos.sh, doctor.ts, gate-p0.ts, gate-p1.ts
- Build: tsc -b works with --ignore-scripts (electron binary not fetched in CI), vitest passes for capture-core
- Security: sanitization, safe URL refs, delete directives, account stamping authority, canaries
- Next steps: real Electron run on macOS 14.0 arm64, owner-session acceptance (email sign-in, one real streamed turn, stop/failure, navigation during stream, reveal/vote, artifact/download), compare evidence classes vs existing exporter
