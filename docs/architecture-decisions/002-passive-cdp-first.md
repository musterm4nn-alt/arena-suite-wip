# ADR 002 — Passive CDP First, Isolated-World Witness Second

**Status:** Accepted
**Date:** 2026-09-17
**Context:** §6 Live capture architecture — need to avoid altering Arena's networking semantics unless measured gap forces gated fallback.

**Decision:**
- Production capture is three-witness system: passive network evidence, target lifecycle evidence, narrow isolated-world rendered-state witness.
- Primary passive network witness uses `Network.requestWillBeSent`, `responseReceived`, `dataReceived`, `loadingFinished`, `loadingFailed`, `streamResourceContent` early, `getResponseBody` reconciliation, WebSocket handshake/frame, EventSource.
- Use `Fetch` response interception only for specific qualified payload family when passive Network proven insufficient. Not default because it perturbs request lifecycle.
- Page-world network monkey-patching is not part of normal design.

**Rationale:**
- Passive observation preserves observed application behavior.
- Service-worker bypass rejected as default because it can change observed behavior; only diagnostic to localize gap.
- Escalation ladder: per-WebContents CDP insufficient -> temporary browser-level CDP (diagnostic, visible flag, no destructive ops) -> app-owned per-session tee/proxy experiment (must prove semantics identical) -> CEF spike -> accept explicit gap or custom Chromium fork last resort.

**Consequences:**
- Need robust stream assembly ledger with gap detection, duplicate handling, UTF-8 boundary testing.
- Need isolated-world witness for UI-only facts: route/conversation ref, participant positions, blind labels, selected labels, vote state, reveal banners, stop/error, UI ordering. Versioned selector adapters with drift counters.
- Need protocol catalog with drift events.

**Verification:** P0 exercises streamed fetch, SSE, WebSocket, RSC-like, partial/stopped/failed, download start, UTF-8 boundary splitting, duplicate replay, queue overflow.
