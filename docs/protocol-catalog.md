# Protocol Catalog

Discovery is permanent subsystem, not temporary reverse-engineering.

## Operation Record

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

Rules:
- Unknown ops stay unknown. Never parse new traffic against guessed schema.
- Read-only is earned. HTTP verb not enough; owner-session probe must establish no observed state change.
- RSC/Next.js traffic is first-class. Initial/history state may arrive in React Server Component/Flight payloads rather than ordinary XHR, so discovery must classify document/RSC responses and not limit itself to API-looking routes.
- Drift events explicit: shape-hash changes, missing terminal markers, unknown fields, unexpected status changes, UI/network disagreement create structured records tied to affected adapter.
- Fail closed on sanitization. If payload cannot be safely projected, persist only error code, byte length, shape hash; never dump raw bytes for convenience.

## Payload Families (initial inventory)

- `arena.chat.stream` — chunked/JSON? streaming assistant output
- `arena.chat.create` — mutate, create conversation/turn
- `arena.history.list` — read, pagination
- `arena.history.detail` — read, conversation detail
- `arena.auth.session` — auth/config
- `arena.artifact.download` — download
- `arena.vote` — mutate? vote/reveal
- `rsc.flight` — RSC payload, document/RSC
- `sse.events` — EventSource
- `ws.arena` — WebSocket

All above are hypotheses until observed in owner session with adapter verification. Until then evidence_state = seen.

## Adapters

- `adapter_arena_stream_v1` — streaming fetch/SSE
- `adapter_arena_history_list_v1`
- `adapter_arena_history_detail_v1`
- `adapter_rsc_flight_v1`
- `adapter_ws_v1`
- `adapter_download_v1`

Each adapter versioned, with drift counters.

## Drift Handling

On drift:
- disable only affected adapter/replay
- retain safe evidence
- ship new adapter
- temporary normalized coverage loss documented
