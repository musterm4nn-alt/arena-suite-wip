# Arena Model Archive — Ultimate Synthesized Architecture Plan

**Status:** Agent-ready implementation plan  
**Platform:** Apple Silicon macOS  
**Primary architecture:** Electron / Chromium + TypeScript  
**Primary interface:** Local MCP  
**Capture strategy:** Passive CDP first, isolated-world UI witness second  
**Fallback architecture:** CEF only if falsification gates prove Electron insufficient

> This Markdown version is derived from the synthesized master plan. It is intended to be handed directly to an implementation agent.

## 1 · Architecture decision

Build a private Apple-Silicon Electron application whose main process owns Arena browser sessions and CDP attachment, while a separate archive service owns encrypted persistence, normalization, jobs, analysis, and MCP. Use passive CDP network observation as the primary capture plane; use an isolated-world DOM witness only for UI-only evidence. Do not use a browser extension, page-world network monkey-patching, WebDriver, or a companion application as the primary architecture.

The decisive property is not that Electron renders Chromium. It is that the application controls *session creation, target attachment timing, partition identity, downloads, target lifecycle, and account-bound requests* before Arena navigation begins. That makes it materially stronger than the existing extension while preserving a mainstream TypeScript stack that AI coding agents can maintain.

#### Primary runtime

Electron/Chromium, one pinned stable major, arm64 only. TypeScript for main, archive service, MCP bridge, adapters, tests and deterministic analysis.

#### Minimum macOS

**macOS 14.0**. If the pinned Electron major's documented floor is later than 14.0, the actual build floor becomes that later version and is recorded in `docs/platform.md`.

#### Persistence

SQLCipher-compatible SQLite + FTS5; large artifacts encrypted individually with AES-256-GCM. Random archive key wrapped by macOS Keychain-backed storage.

#### Automation

MCP is the primary operator surface: stdio bridge → Unix domain socket by default. Optional loopback Streamable HTTP only when a client cannot use stdio.

## 2 · Non-negotiable design rules

1. **Unknown remains unknown.** Missing data, model identity, endpoint semantics, ownership, and completeness are represented explicitly, never guessed.
2. **Account scope is part of identity.** Every observation, conversation, artifact, sync checkpoint, provenance record and destructive action is keyed by a stable local `account_id` plus a session epoch where relevant.
3. **Capture does not imply completeness.** A turn becomes `complete` only from positive terminal evidence and absence of a known observer gap.
4. **Remote content is data, never authority.** Archived prompts, responses, tool traces, filenames, DOM text and diagnostics cannot authorize deletion or privileged actions.
5. **Passive observation first.** Production capture must not alter Arena's networking semantics unless a measured gap forces an explicitly gated fallback.
6. **Evidence earns automation.** A history operation is not replayed merely because it is GET-shaped or looks read-only. Owner-session probes qualify it first.
7. **One account failing must not degrade another.** Auth expiry, challenge, drift, crash or sync failure in A cannot silently pause, rebind or corrupt B.
8. **The first implementation phase tries to break the architecture.** Happy-path demos are not architecture validation.

## 3 · Architecture selection

Eligible and baseline architectures, judged by the capabilities that matter.

| Candidate | Out-of-band capture | Account isolation | Artifacts | Agent maintainability | Decision |
| --- | --- | --- | --- | --- | --- |
| Swift + WKWebView | Insufficient public HTTPS body/stream visibility for the required capture depth. | Strong WebKit data-store isolation. | Manageable. | Good native ergonomics. | Reject as primary capture shell. |
| Tauri/Wry | On macOS inherits WKWebView's decisive capture limitation. | Reasonable. | Reasonable. | Rust + WebKit, but capture ceiling remains. | Reject. |
| **Electron/Chromium** | CDP Network/Target/Runtime; bodies/chunks, WS, EventSource; early target control. | First-class persistent sessions; explicit per-account directories. | `will-download`, direct save path and app-owned encryption. | **Best**: TypeScript, mainstream docs, prebuilt arm64 runtime. | **Selected.** |
| CEF | Excellent: native request/response filters plus CDP. | Strong request contexts. | Strong. | Higher C++/CMake/helper/signing burden. | Keep as browser-adapter escalation if Electron cannot observe a required class reliably. |
| Extension + native host | Can improve with debugger, but retains extension lifecycle/attachment/bridge complexity. | Browser-profile dependent. | Awkward. | Known baseline. | Rejected by product requirement. |
| Export/import only | No live capture. | Trivial. | Only what export contains. | Simple. | Support as an ingestion adapter, not the product. |

#### Electron vs CEF decision

CEF has a higher native interception ceiling, but Electron already exposes the observation surfaces required for v1 while dramatically reducing implementation and maintenance cost. Therefore the core services are deliberately browser-adapter-independent: if the hostile capture spike demonstrates a required observation that Electron cannot obtain without unacceptable semantic changes, replace only the browser adapter with CEF. Do not redesign storage, identity, MCP, sync or analysis.

## 4 · Process and trust model

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

**Arena renderers:** `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, no application preload API, no filesystem, no database, no key access, no MCP access. The only injected code is a read-only isolated-world witness installed by CDP; removing it must degrade only UI corroboration, not network capture.

**Diagnostics GUI:** local app origin, strict CSP, narrow context bridge. GUI and MCP call the same typed service registry so semantics cannot drift.

**Archive service:** sole database writer. The main process may briefly unwrap the archive key through the Keychain-backed broker at unlock time, transfers it to the archive service, then drops its copy. This transient exposure is explicitly part of the threat model; no key is written to ordinary app files.

## 5 · Simultaneous account isolation

Each Arena account is represented by an immutable local UUID. Create its Chromium session with an explicit app-controlled storage directory such as `Application Support/ArenaArchive/partitions/<account_uuid>/`. Never derive storage paths from email addresses, display names, Arena model labels or page data.

| Boundary | Rule | Blocking test |
| --- | --- | --- |
| Browser state | One persistent Session per account: cookies, local/session storage, IndexedDB, HTTP cache, CacheStorage and service-worker registrations stay partition-scoped. | Write unique sentinels in A/B and verify no cross-read after restart. |
| Capture authority | `account_id` is stamped by the CaptureSupervisor that owns the WebContents; page payloads cannot set it. | Fuzz page-supplied account-like fields and assert the database account remains supervisor-derived. |
| Session epoch | Every successful sign-in starts an epoch. Sign-out, identity mismatch or credential invalidation ends it. | Sign out A while B streams; A stops, B remains uninterrupted. |
| Sync | One queue, token bucket, cursor/checkpoint chain and auth state per account. | Expire A during concurrent A+B sync; B continues. |
| Artifacts | Initiating session determines artifact account before file linkage. | Same filename/source URL in two accounts remains two provenance records. |
| Deletion | Directive binds canonical account/conversation IDs and scope hash. | A directive for A cannot delete B. |

### Sign-in

Sign-in is owner-driven inside the target Arena view. Email verification links, codes, MFA, redirects and challenges are handled interactively; the app does not read mail or solve challenges. Popups required by the flow remain in the same partition. On a challenge, only that account enters `owner_action_required`; automated traversal and sync pause while passive capture may continue.

Do not import cookies from another browser. Do not store passwords, email codes, bearer tokens or copied session credentials in the archive. Browser-managed partition state remains a residual plaintext/browser-managed exposure protected by filesystem permissions and FileVault, not by SQLCipher.

## 6 · Live capture architecture

The production capture path is a three-witness system: passive network evidence, target lifecycle evidence, and a narrow isolated-world rendered-state witness. Page-world network patching is not part of the normal design.

### 6.1 Attach-before-navigate protocol

```
create account WebContents with NO Arena URL loaded
bind WebContents -> account_id
create bounded capture queue
debugger.attach()
Network.enable(explicit buffers; durable messages if supported by pinned Chromium)
Page.enable()
Runtime.enable()
Runtime.addBinding("__ARENA_ARCHIVE__", isolated-world only)
Page.addScriptToEvaluateOnNewDocument(readOnlyWitness, worldName="arena-archive")
Target.setAutoAttach(autoAttach=true, flatten=true, waitForDebuggerOnStart=true)
verify acknowledgements
ONLY THEN navigate to https://arena.ai/

on Target.attachedToTarget(sessionId):
  bind child target to parent account
  enable Network in child session
  enable only needed Runtime/Page domains
  install witness where meaningful
  runIfWaitingForDebugger()
```

Open DevTools on Arena WebContents is prohibited because it can detach Electron's debugger. Provide a separate diagnostics window and capture harness instead.

### 6.2 Primary passive network witness

- Use `Network.requestWillBeSent`, `responseReceived`, `dataReceived`, `loadingFinished` and `loadingFailed`.
- For identified streaming operations, request `Network.streamResourceContent` early and assemble the returned buffered bytes plus later chunk data. At completion, use `Network.getResponseBody` as a reconciliation source where appropriate.
- Capture WebSocket handshake/frame events and EventSource message events independently; never force all transports through one parser.
- Use `Fetch` response interception only for a specific qualified payload family when passive Network capture is proven insufficient. Interception is not the default because it perturbs the request lifecycle.
- Every event is routed by `sessionId`/`targetId`, then stamped with `account_id` and `session_epoch_id` before entering any shared queue.

### 6.3 Stream assembly ledger

Maintain an assembly record per logical request/stream: monotonic chunk sequence, byte length, content hash, duplicate count, first/last timestamps, expected content length when known, transport terminal signal, parser terminal signal, target/session provenance, and gap intervals. Replayed chunks are counted but not appended twice. UTF-8 and logical record boundaries are tested under arbitrary chunk splitting.

### 6.4 Rendered-state witness

The isolated-world witness records only UI facts unavailable or more authoritative in rendered state: route/conversation reference, participant positions, blind labels, selected labels, visible vote state, reveal banners, stop/error state and UI ordering. It sends typed observations through one binding and has no privileged return channel. DOM selectors are versioned adapters with their own drift counters.

#### Do not bypass the service worker in production by default

Disabling or bypassing Arena's service worker can change the application being observed. Production first attempts flattened attachment to service-worker and worker targets and reconciles page/network evidence. Service-worker bypass may be used only in a diagnostic experiment to localize a gap, never silently as the normal browser configuration.

### 6.5 Escalation ladders

| Observed failure | Next instrument | Cost / rule |
| --- | --- | --- |
| Per-WebContents CDP cannot see a required target class. | Temporary browser-level CDP endpoint bound to loopback. | Diagnostic only; visible state flag; no destructive operations while open; close immediately after test. |
| Target is visible but required response bytes are persistently unavailable/truncated. | App-owned, per-session network tee/proxy experiment. | Must prove request semantics, redirects, cookies, uploads and streaming remain identical before any production use. |
| Electron still cannot observe a required class without semantic distortion. | CEF BrowserAdapter spike. | Use native response filters/request contexts; keep core services unchanged. |
| CEF also cannot meet a genuinely required observation. | Accept explicit coverage gap or, only if the requirement justifies it, investigate a custom Chromium fork. | A Chromium fork is a last resort, not a v1 plan. |

## 7 · Completeness, reconciliation, and branches

| State | Meaning | Analysis default |
| --- | --- | --- |
| `complete` | Positive terminal evidence and no unresolved observer gap at the ending. | Included. |
| `stopped_by_user` | Owner/client abort evidence exists. | Excluded unless explicitly requested. |
| `failed_transport` | Transport/protocol failure ended the turn. | Excluded. |
| `partial_stream` | Content exists but stream ended without a valid terminal signal. | Excluded. |
| `observer_gap` | The app knows observation was absent or evicted while output may have occurred. | Excluded. |
| `reconstructed_ui_only` | Only rendered-state evidence exists. | Excluded from wire-timing claims. |
| `imported` | Imported from prior archive/export with inherited limitations. | Separate cohort by default. |
| `unknown` | State cannot be established. | Excluded. |

A later history read may promote a partial turn to complete only if it unambiguously covers the same account, conversation, branch and revision and reconciles the content. Promotion adds a provenance event; it never overwrites the original gap evidence.

### Branches and revisions

Regeneration, retry and edit create branch/revision relationships; they do not replace prior outputs. Conversation text is never treated as the deduplication key. Reconnects are reconciled using source IDs/event IDs where available plus normalized structural hashes inside the same account and revision scope.

## 8 · Discovery, protocol catalog, and drift

Discovery is a permanent product subsystem, not a temporary reverse-engineering step. Broadly inventory first-party traffic; narrowly retain only payload classes required for archive correctness.

```
protocol_op {
  id
  host_class
  method
  path_template              // identifiers masked
  transport                  // json | chunked | sse | websocket | download | rsc | unknown
  direction                  // read | mutate | asset | auth | config | unknown
  evidence_state             // seen | classified | adapter_ready | owner_verified_read | deprecated
  account_binding_evidence
  payload_family
  shape_hash
  adapter_id + adapter_version
  completeness_model
  first_seen + last_seen
  drift_counters
}
```

- **Unknown operations stay unknown.** Never parse new traffic against a guessed schema.
- **Read-only is earned.** HTTP verb is not enough; an owner-session probe must establish no observed state change.
- **RSC/Next.js traffic is first-class.** Initial or history state may arrive in React Server Component/Flight payloads rather than ordinary XHR, so discovery must classify document/RSC responses and not limit itself to API-looking routes.
- **Drift events are explicit.** Shape-hash changes, missing terminal markers, unknown fields, unexpected status changes and UI/network disagreement create structured records tied to the affected adapter.
- **Fail closed on sanitization.** If a payload cannot be safely projected, persist only error code, byte length and shape hash; never dump raw bytes for convenience.

## 9 · Existing-history synchronization

Primary: replay observed owner-history reads only after they are qualified as account-bound, effectively read-only and pagination-stable. Fallback: controlled UI traversal whose network observations still flow through the normal capture system. Passive navigation and rendered-history maps remain useful evidence but never imply completeness.

### 9.1 Read qualification probe

1. Require a current session epoch and identity probe for the account.
2. Observe the operation during normal owner usage and bind it to the partition.
3. Capture a server-visible target fingerprint before replay.
4. Issue exactly one same-session request. Prefer the app-owned Session fetch path when it works without copying secrets; otherwise use a narrow same-partition execution path that keeps transient credentials inside Chromium.
5. Capture the fingerprint after replay. Any change or inability to establish equivalence yields `mutation_unknown` and blocks autonomous replay.
6. Observe a pagination boundary and repeat a page to establish cursor/order behavior.
7. Cross-check at least one detail read against a conversation captured live.
8. Record the probe; any later drift invalidates qualification until reprobed.

### 9.2 Sync job semantics

| Concern | Rule |
| --- | --- |
| States | `queued → running ⇄ paused → completed | completed_with_gaps | failed | cancelled`, with blocking reasons such as auth, rate-limit, challenge, drift, account mismatch. |
| Checkpoint | Last fully committed page/cursor, page fingerprint, seen-set digest, counts, adapter version and run sequence, transactionally committed with covered items. |
| Retries | Bounded exponential backoff with jitter for transport/429/5xx only. Never retry auth failure or a suspected mutation. |
| Concurrency | Independent per-account jobs; start with global concurrency 2 and one request at a time per account, then tune from measurements. |
| Overlap | Repeated pages are expected; idempotent upsert inside account scope. Changed content becomes a new observation/revision or explicit conflict. |
| Instability | Changing page fingerprints/cursors create `pagination_instability`; re-walk a conservative overlap window or degrade to traversal. |
| Live overlap | Do not overwrite an in-flight live turn. Reconcile after stream close; conflicts remain visible. |
| Auth/account change | Pause that account at its checkpoint; re-probe identity before resuming. |

### 9.3 “Synchronized” is a coverage report

```
coverage {
  account_id
  listing_method
  listing_verified_at
  newest_seen / oldest_seen
  items_known
  items_archived
  items_complete
  items_partial
  items_unknown_content
  detail_failures
  pagination_gaps[]
  ownership_conflicts[]
  adapter_gaps[]
  last_run
  confidence_statement
}
```

If no reliable listing exists, the product remains useful: live capture continues; controlled history traversal and rendered history build a map of known conversations; imports fill older gaps; the coverage report says historical completeness is unknown.

## 10 · Data model, provenance, and model identity

Use a three-layer hybrid: append-only sanitized observations, a normalized relational core, and disposable derived projections. This preserves reparsability without imposing full event-sourcing complexity.

```
account
  └─ partition
      └─ session_epoch
          ├─ observation*
          ├─ sync_job -> checkpoint*
          └─ conversation*
               ├─ branch*
               │    └─ turn*
               │         └─ part*
               ├─ participant*
               │    └─ identity_claim*
               ├─ artifact*
               └─ conflict*

protocol_op -> adapter_version
analysis_run -> cohort_definition -> metric*
delete_tombstone / suppression_marker
```

### 10.1 Critical identity rules

- Local `account_id` is the durable archive key; observed Arena identifiers are evidence attached to it.
- Arena participant position, blind label, selected model label, request/catalog identifier, displayed provider/model name and post-vote reveal are separate evidence types.
- Identity claims are append-only and scoped to the smallest supported turn range/time interval.
- A resolved identity is a *view*, never a mutation. Precedence may prefer a reveal over a selected label, but all evidence remains inspectable.
- Battle participants can change after votes; never assume one hidden model per conversation.
- Style/model-fingerprint inference is stored in a separate experiment namespace and can never update observed identity.

### 10.2 Provenance

Every important normalized field points to one or more observation records containing: account/session epoch, observation mechanism, target/session, operation key, adapter/version, observed time, completeness state and sanitized evidence reference. Derived fields store reducer/analysis version and source record IDs.

### 10.3 Transaction and crash model

- Archive service is the single SQLite writer.
- First durable write is an append-only `observations` record in SQLCipher; normalization happens in the same or a subsequent bounded transaction. This uses the encrypted database itself as the journal and avoids a second persistence format.
- WAL is encrypted with the database. Use conservative durability settings; measure capture latency before tuning.
- Artifact commit protocol: stage → hash/MIME sniff → encrypt to temp sealed blob → fsync → atomic rename → DB commit → remove plaintext staging file.
- On startup run integrity checks, recover orphan staging files, reconcile blob rows, and rebuild derived FTS/projections when necessary.
- Schema migrations are numbered, transactional, forward-only, preceded by a verified encrypted backup.

## 11 · Storage, secret handling, backup, and deletion

### 11.1 Encryption

- Generate a random 256-bit archive key.
- Protect the wrapped key with macOS Keychain-backed storage; keep the active key in the archive service only while unlocked.
- Encrypt SQLite/FTS with SQLCipher-compatible encryption.
- Encrypt large artifacts individually with AES-256-GCM using per-blob nonces and authenticated metadata containing blob id/account/source hash.
- Never claim Chromium partition directories are SQLCipher-protected. They contain browser-managed session data and rely on app directory permissions + macOS/FileVault residual protection.

### 11.2 Sanitization before persistence

Drop—not merely redact later—Authorization, Cookie, Set-Cookie, passwords, MFA/verification codes, OAuth codes, CSRF/security tokens, copied bearer strings and secret signed-URL parameters. Represent a sensitive resource URL as a safe reference such as `{host,path,query_key_set,query_hash,expiry_class}`, sufficient for correlation but not replay.

Authentication and account-mutation payloads are inventory-only unless a narrowly reviewed field is essential. Parser failures never trigger raw dumps. Ordinary logs contain structured event codes and safe identifiers only.

### 11.3 Destructive-action guard

1. MCP cannot mint approval.
2. Trusted GUI or local interactive CLI shows exact canonical scope and creates a random, single-use, short-lived directive.
3. Directive stores scope IDs + count + canonical scope hash + creation time + nonce.
4. Deletion tool must supply directive ID and matching arguments; mismatch, expiry or replay returns `E_CONFIRM_REQUIRED`.
5. Archive-wide deletion requires the strongest owner gesture; account-wide and conversation-level confirmations remain scope-specific.
6. Deletion first pauses affected capture/sync, writes a tombstone/suppression marker, removes normalized rows/FTS/linked evidence/artifacts transactionally where possible, then vacuums/compacts opportunistically.
7. External exports and backups are reported as residual copies; the app does not promise deletion from files it no longer controls.

### 11.4 Backup / restore

Backups are encrypted bundles containing the database plus sealed artifacts and a manifest. `maintenance_backup` is successful only after reopening the bundle in a verification path and comparing manifest counts/hashes. Restore is destructive, requires a directive, and runs only with capture/sync stopped.

## 12 · Complete MCP / LLM operation contract

**Default transport:** a small stdio bridge process connects to a Unix domain socket owned by the running archive service, mode `0600`. This gives normal MCP client ergonomics without leaving a TCP listener. Optional Streamable HTTP on `127.0.0.1` may be enabled explicitly for clients that require it; use an ephemeral port, bearer token, Host/Origin validation, no CORS, and block Arena sessions from loopback.

### 12.1 Service domains

| Domain | Representative tools |
| --- | --- |
| Accounts | `accounts_list`, `accounts_get`, `accounts_begin_signin`, `accounts_identity_probe`, `accounts_set_enabled` |
| Capture | `capture_status`, `capture_pause`, `capture_resume`, `capture_stop_all`, `capture_completeness`, `capture_repair` |
| Sync | `sync_start`, `sync_status`, `sync_pause`, `sync_cancel`, `sync_resume`, `sync_coverage`, `sync_verify_read` |
| Archive | `archive_search`, `archive_get_conversation`, `archive_get_turn`, `archive_get_provenance`, `archive_list_branches`, `archive_export`, `archive_import`, `archive_get_artifact` |
| Diagnostics | `diagnostics_capabilities`, `diagnostics_protocol_catalog`, `diagnostics_drift`, `diagnostics_evidence`, `diagnostics_storage_health`, `diagnostics_recover` |
| Analysis | `analysis_profiles_run`, `analysis_profiles_get`, `analysis_compare`, `analysis_excerpts`, `analysis_experiments` |
| Maintenance | `maintenance_backup`, `maintenance_restore`, `maintenance_lock`, `maintenance_unlock`, destructive delete tools requiring directives |

### 12.2 Contract rules

- Every tool that touches account data accepts explicit account IDs or an explicit `all` sentinel; account scope is never inferred from current GUI focus.
- Long work returns a job ID and exposes `status/cancel/resume`. Checkpoints survive restart.
- Cursor pagination is used for archive reads; identifiers are opaque.
- `diagnostics_capabilities` is the recommended first call and explains unavailable/degraded features rather than hiding tools.
- Typed errors: `E_SCOPE_MISMATCH`, `E_AUTH_EXPIRED`, `E_OWNER_ACTION_REQUIRED`, `E_RATE_LIMITED`, `E_CONFIRM_REQUIRED`, `E_LOCKED`, `E_DRIFT`, `E_UNSUPPORTED`, `E_PARTIAL`, `E_BUSY`.
- GUI/MCP parity is tested in CI by enumerating service commands. No essential workflow is GUI-only; owner-attended steps are represented as `NEEDS_OWNER_INTERACTION` states.
- Do not expose generic arbitrary JavaScript, arbitrary HTTP request, raw SQL or shell execution as MCP tools. Those would erase the security model.

## 13 · Local analysis

The v1 research engine is deterministic. It operates on immutable corpus snapshots identified by a corpus hash plus adapter/code/config versions. By default it includes only `complete` turns whose model cohort is based on observed/revealed identity evidence.

| Family | Examples | Main confounds |
| --- | --- | --- |
| Structure | response/paragraph/sentence/code-block lengths, headings, lists, tables, citation frequency, code/prose ratio | Prompt formatting requests, Arena rendering/post-processing |
| Lexical | moving lexical diversity, recurring n-grams, punctuation/casing, emoji/symbol patterns | Topic/language/tokenizer version |
| Discourse | openings, transitions, conclusions, hedging, refusals, apologies, uncertainty markers | Safety/system prompts and conversation context |
| Interactive | tool counts/types, reasoning-part presence/length, finish reason, first-part/completion latency where reliable | Different harnesses/tools/modes |
| Variation | slices by prompt type, topic, mode, language, time and conversation depth | Sparse slices and owner selection bias |

Every metric returns sample count and cohort definition. Representative excerpts are chosen deterministically and link back to provenance.

### 13.1 What the corpus can support

It can describe within-user, within-cohort behavior and suggest differences on carefully matched prompts. It cannot establish universal model behavior, exact model build, authorship or hidden orchestrator identity from style alone.

### 13.2 Fingerprinting / similarity gate

Only after a written question cannot be answered deterministically: use conversation-level train/test separation, keep branches and near-duplicates together, match or stratify prompts/topics, include same-model/different-topic and different-model/same-prompt controls, calibrate an unknown class, pin preprocessing/model weights/seeds, predeclare stop criteria, and report negative results. Inference output is never allowed to mutate observed identity.

## 14 · Incremental modality roadmap

| Order | Modality | Reuse | New work / entry gate |
| --- | --- | --- | --- |
| 1 | Search + citations | turn/part/provenance/completeness | Citation part schema after one real search-mode capture. |
| 2 | Code / web outputs | artifact store, downloads, tool parts | Workspace/preview/tool-event adapters after one complete Code session with an artifact. |
| 3 | Images | sealed artifacts + quotas | Prompt↔image linkage, metadata after observable asset capture. |
| 4 | Video/workflows | job engine + artifact store | large streaming files, thumbnails, long-running states after real evidence. |
| 5 | Agent sessions | tool-call/result parts | orchestrator identity remains unknown unless observed; harness metadata is not identity. |
| 6 | Uploads/derived artifacts | source refs + encryption | owner decides whether bodies merit retention; add derived-from graph. |

## 15 · Implementation sequence and acceptance gates

No calendar estimates. Each phase is earned by evidence.

### P0 · Hostile browser/capture falsification spike

**Build only:** Electron shell, two account sessions, CDP supervisor, in-memory/small encrypted test journal, diagnostic output. No full DB schema, no analysis, no polished GUI.

- Assert attach/domain-enable occurs before first Arena navigation request.
- Exercise page, iframe, dedicated worker, shared worker and service-worker target creation; freeze/arm/resume child targets.
- Force navigation and renderer process loss during streams.
- Split synthetic stream records at every UTF-8/logical boundary; replay duplicate chunks; overflow bounded queues deliberately.
- Exercise streamed fetch, SSE, WebSocket, RSC-like payload, partial/stopped/failed outcomes and download start.
- Run two accounts simultaneously with distinct storage/network sentinels.
- Owner-session acceptance: email sign-in, one real streamed turn, one stop/failure, one navigation during stream, one reveal/vote workflow where applicable, and one real artifact/download where available.
- Where practical run the same benign workflow under the existing exporter and compare *evidence classes and gaps*, not generated text equality.

**Decision:** continue only if Electron shows materially stronger/reliable evidence with explicit gaps. If target coverage fails, test browser-level CDP. If body coverage fails, test the proxy/tee. If required coverage still fails or requires semantic distortion, execute a bounded CEF spike before building higher layers.

### P1 · Smallest vertical slice

One account, one complete stream, one crash-during-stream producing `partial_stream`, SQLCipher observation+normalized records, transcript query through MCP, provenance lookup, scratch deletion with directive. This proves browser → sanitizer → storage → transcript → MCP.

### P2 · Complete text capture

Battle, Direct and Side-by-Side; completed/stopped/failed/partial; branches/regenerations; late model identity; history-opened conversations; worker/SW coverage; UI/network reconciliation; downloads linked when available. Golden fixtures and property tests vary chunk boundaries/order/duplicates.

### P3 · Multi-account trust and storage integrity

Two live accounts across restart; cross-account collision tests; auth expiry and identity rebind tests; secret canaries through success/error paths; disk-full and crash injection; migration backup/restore; artifact sealing and plaintext staging cleanup.

### P4 · Backfill qualification and synchronization

Read probes, stable pagination/detail cross-check, interruption/resume, overlap/re-run, concurrent accounts, live-capture overlap, challenge/rate-limit/drift behavior, coverage report.

### P5 · Agent-operation parity

Scripted MCP client exercises every GUI service. Malicious archived text requests destructive actions and must fail without a separately minted exact-scope directive. Generic execution escape hatches are absent.

### P6 · Heavy-use measurement and text-v1 release

Measure process-tree memory, macOS memory pressure/swap deltas, CPU, queue high-water marks, capture lag, DB growth/query latency, artifact throughput and sync rate on the owner's M3 Pro / 18 GB machine. Set quotas from observations. Under pressure, reduce sync/analysis/tab concurrency before sacrificing capture correctness.

### P7 · Deterministic analysis

Golden feature tests, corpus hashes, cohort/missingness reports, offline operation, representative excerpts. Any later ML experiment must pass its separate scientific gate.

## 16 · Risks and architecture reversal rules

| Risk | Detection | Fallback | Capability loss |
| --- | --- | --- | --- |
| Required worker/SW target invisible through WebContents debugger | P0 target matrix / unexplained UI-network mismatch | Temporary browser-level CDP; then CEF if persistent | Additional local attack surface during diagnostics, or higher maintenance under CEF |
| Streaming bodies unavailable/truncated | byte ledger mismatch / terminal mismatch | targeted Fetch path → proxy/tee experiment → CEF | Potential semantic risk; if unresolvable, affected mode carries explicit gaps |
| Arena protocol drift | shape hashes, parse errors, unknown ops, terminal anomalies | disable only affected adapter/replay, retain safe evidence, ship new adapter | temporary normalized coverage loss |
| No reliable history listing | pagination probe fails | UI traversal + passive capture + imports | no strong full-history completeness claim |
| Account ownership ambiguous | identity probe mismatch / unexpected account reference | quarantine scope; stop replay | automatic backfill for that scope |
| Challenge / auth expiry | owner-action state / auth failures | pause only affected account, owner resolves | continuity gap is recorded |
| Native DB module breaks on Electron upgrade | build/boot gate | pin major; evaluate alternate SQLCipher binding without changing schema boundary | upgrade delay |
| Disk/memory pressure | resource diagnostics / queue high water / free-space alarms | pause sync/analysis, close idle views, reduce artifact/evidence retention | optional artifacts/diagnostics before transcript correctness |
| Prompt injection in archive | adversarial MCP tests | typed services + independent directive broker | unsafe action remains unavailable |
| Style signal collapses under prompt controls | held-out negative controls | retain descriptive profiles; abandon identity claim | no fingerprint attribution conclusion |

## 17 · Recommended repository / package layout

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
    ...
```

Every gate produces a machine-readable result such as `artifacts/gates/p0.json` containing test version, runtime versions, passed/failed checks, measured facts and explicit falsifiers. Coding agents should read the latest gate artifact before making architecture changes.

## 18 · Corrections and choices applied during synthesis

#### Kept

015's evidence-first backbone, 022's attach hazards/assembly discipline, 014's process separation and fallback ladder, 012's session-epoch framing, 021's completeness model, 023's read qualification and sync semantics, 031's RSC awareness, 029's hostile falsification discipline.

#### Changed

Passive Network capture is preferred over always-on Fetch interception. Production service-worker bypass is rejected as a default because it can change observed behavior. The network proxy is a gated experiment, not assumed infrastructure.

#### Explicitly excluded

Nonexistent CDP names such as `Fetch.takeResponseBodyForInterceptionAsStream`; invented font URLs; the false claim that CEF lacks maintained response filters; arbitrary MCP HTTP/JS/SQL/shell escape hatches; exporter version claims not supported by repository releases.

#### Evidence policy

Platform capability does not prove Arena transport usage. Bundle/public-route evidence can seed the protocol catalog, but current owner-session observations and gates decide production adapters.

## 19 · Synthesis basis

This master plan is a synthesis of the Arena Suite v3 corpus at repository commit `4abd43804cde604d08f03cf27aaf03303a52962c`, with the consensus ranking used to prioritize source plans. It is not a claim that every Arena-specific transport detail in every source plan is currently verified.

- **015:** overall backbone — privilege planes, protocol catalog, read-qualified backfill, hybrid provenance model, complete MCP inventory, deterministic analysis and evidence-gated phases.
- **022:** attach ordering, target freeze/arm/resume, per-request assembly discipline, DevTools detach hazard, narrow retention and fail-closed sanitization.
- **014:** process separation, browser-adapter replaceability, focused fallback ladder.
- **012:** explicit session epochs, account-bound capture fabric, agent-maintainable architecture framing.
- **021:** completeness state model, promotion rules, late identity evidence and hostile vertical slice.
- **023:** read-behavior probes, sync state/checkpoint semantics and coverage reporting.
- **031:** Next.js/RSC blind-spot awareness, arm64 dependency posture and browser-level CDP security cost.
- **029:** strongest CEF alternative and adversarial gate design.

**Implementation north star:** the archive is not valuable because it stores a lot of text. It is valuable because every stored statement about ownership, completeness and model identity can answer: *what did we observe, from which account/session, through which mechanism, when, with what adapter, and what could still be missing?*

Typography: Departure Mono is loaded from the official departuremono.com asset URL with system monospace fallbacks. The report remains usable if the remote font is unavailable.
