# Evidence Register

Machine-readable gate results: `artifacts/gates/p*.json`

Each gate artifact contains:
- test_version
- runtime_versions (electron, chromium, node)
- passed/failed checks
- measured facts
- explicit falsifiers
- timestamp
- platform

## P0 Falsification Spike

Goal: break architecture before building higher layers.

To be populated by `scripts/gate-p0.ts` run.

Expected evidence classes:
- attach-before-navigate ordering proof (timestamp of debugger attach vs first requestWillBeSent for arena.ai)
- target coverage matrix: page, iframe, dedicated worker, shared worker, service worker — seen via Target.attachedToTarget
- freeze/arm/resume child targets — documented
- stream assembly: UTF-8 boundary splitting, duplicate handling, bounded queue overflow behavior
- transport coverage: streamed fetch, SSE, WebSocket, RSC-like, partial/stopped/failed, download start
- dual-account isolation: storage sentinels not cross-readable, network account_id stamping supervisor-derived
- owner-session notes (manual, if applicable)

Decision criteria:
- Continue if Electron shows materially stronger/reliable evidence with explicit gaps documented.
- If target coverage fails -> test browser-level CDP (diagnostic flag)
- If body coverage fails -> proxy/tee experiment (prove semantics identical)
- If required coverage still fails or requires semantic distortion -> bounded CEF spike before higher layers

## P1 Vertical Slice

One account, one complete stream, one crash-during-stream producing partial_stream, SQLCipher observation+normalized records, transcript query through MCP, provenance lookup, scratch deletion with directive. Proves browser -> sanitizer -> storage -> transcript -> MCP.

## Future Gates

P2 Complete text capture, P3 Multi-account trust, P4 Backfill qualification, P5 Agent-operation parity, P6 Heavy-use measurement, P7 Deterministic analysis
