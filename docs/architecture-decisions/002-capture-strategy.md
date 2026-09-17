# ADR 002: Passive CDP first, isolated-world witness second

- **Status:** Accepted
- **Context:** Need to capture Arena conversations without altering Arena's networking semantics. Options: page-world network monkey-patching, Fetch interception always-on, passive CDP observation, proxy/tee, extension debugger.
- **Decision:** Passive CDP network observation as primary capture plane; isolated-world DOM witness only for UI-only evidence. Do not use browser extension, page-world network patching, WebDriver, or companion app as primary.
- **Details:**
  - Use Network.requestWillBeSent, responseReceived, dataReceived, loadingFinished, loadingFailed
  - For streaming, request Network.streamResourceContent early and assemble buffered bytes plus later chunk data. At completion, use Network.getResponseBody as reconciliation
  - Capture WebSocket handshake/frame events and EventSource message events independently
  - Use Fetch response interception only for specific qualified payload family when passive insufficient — not default because it perturbs lifecycle
  - Every event routed by sessionId/targetId, then stamped with account_id and session_epoch_id before shared queue
  - Stream assembly ledger maintains monotonic chunk sequence, byte length, hash, duplicate count, timestamps, expected length, terminal signals, provenance, gap intervals
  - Rendered-state witness records only UI facts unavailable or more authoritative in rendered state: route/conversation ref, participant positions, blind labels, selected labels, vote state, reveal banners, stop/error state, UI ordering. Typed observations through one binding, no privileged return channel. Selectors versioned adapters with drift counters
- **Consequences:** Preserves observed application semantics, materially stronger than extension while keeping mainstream TS stack. Requires attach-before-navigate protocol and flattened auto-attach for workers/SW.
- **Validation:** P0 must exercise streamed fetch, SSE, WebSocket, RSC-like payload, partial/stopped/failed, and prove no semantic distortion.
