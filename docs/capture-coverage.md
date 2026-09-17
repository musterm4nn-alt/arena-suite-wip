# Capture Coverage

## Three-witness system

- **Passive network evidence (primary):** Network.requestWillBeSent, responseReceived, dataReceived, loadingFinished, loadingFailed, WebSocket handshake/frame events, EventSource message events, Network.streamResourceContent early + getResponseBody reconciliation, Fetch response interception only for specific qualified payload family when passive insufficient.
- **Target lifecycle evidence:** Target.attachedToTarget, flattened auto-attach, freeze/arm/resume child targets.
- **Narrow isolated-world rendered-state witness:** route/conversation reference, participant positions, blind labels, selected labels, visible vote state, reveal banners, stop/error state, UI ordering. Typed observations through one binding, no privileged return channel. DOM selectors versioned adapters with drift counters.

## Completeness states

- complete: positive terminal evidence and no unresolved observer gap at ending — included in analysis by default.
- stopped_by_user: owner/client abort evidence exists — excluded unless explicitly requested.
- failed_transport: transport/protocol failure ended turn — excluded.
- partial_stream: content exists but stream ended without valid terminal signal — excluded.
- observer_gap: app knows observation absent or evicted while output may have occurred — excluded.
- reconstructed_ui_only: only rendered-state evidence exists — excluded from wire-timing claims.
- imported: imported from prior archive/export with inherited limitations — separate cohort by default.
- unknown: state cannot be established — excluded.

Later history read may promote partial to complete only if unambiguously covers same account, conversation, branch, revision and reconciles content. Promotion adds provenance event; never overwrites original gap evidence.

## Stream assembly ledger

Per-request record: monotonic chunk sequence, byte length, content hash, duplicate count, first/last timestamps, expected content length when known, transport terminal signal, parser terminal signal, target/session provenance, gap intervals. Replayed chunks counted but not appended twice. UTF-8 and logical record boundaries tested under arbitrary chunk splitting.

## Do not bypass service worker in production by default

Disabling/bypassing Arena's service worker can change application being observed. Production first attempts flattened attachment to service-worker and worker targets and reconciles page/network evidence. Service-worker bypass may be used only in diagnostic experiment to localize gap, never silently as normal browser config.

## Escalation ladders

| Observed failure | Next instrument | Cost/rule |
| --- | --- | --- |
| Per-WebContents CDP cannot see required target class | Temporary browser-level CDP endpoint bound to loopback | Diagnostic only; visible state flag; no destructive ops while open; close immediately after test |
| Target visible but required response bytes persistently unavailable/truncated | App-owned, per-session network tee/proxy experiment | Must prove request semantics, redirects, cookies, uploads and streaming remain identical before production use |
| Electron still cannot observe required class without semantic distortion | CEF BrowserAdapter spike | Use native response filters/request contexts; keep core services unchanged |
| CEF also cannot meet genuinely required observation | Accept explicit coverage gap or, only if requirement justifies it, investigate custom Chromium fork | Chromium fork is last resort, not v1 plan |
