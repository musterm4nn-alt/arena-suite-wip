# Protocol Catalog

Discovery is permanent product subsystem, not temporary reverse-engineering. Broadly inventory first-party traffic; narrowly retain only payload classes required for archive correctness.

## Operation schema

```
protocol_op {
  id
  host_class
  method
  path_template // identifiers masked
  transport // json | chunked | sse | websocket | download | rsc | unknown
  direction // read | mutate | asset | auth | config | unknown
  evidence_state // seen | classified | adapter_ready | owner_verified_read | deprecated
  account_binding_evidence
  payload_family
  shape_hash
  adapter_id + adapter_version
  completeness_model
  first_seen + last_seen
  drift_counters
}
```

- Unknown operations stay unknown — never parse new traffic against guessed schema.
- Read-only is earned — HTTP verb not enough; owner-session probe must establish no observed state change.
- RSC/Next.js traffic is first-class — initial or history state may arrive in React Server Component/Flight payloads rather than ordinary XHR, so discovery must classify document/RSC responses and not limit itself to API-looking routes.
- Drift events explicit — shape-hash changes, missing terminal markers, unknown fields, unexpected status changes and UI/network disagreement create structured records tied to affected adapter.
- Fail closed on sanitization — if payload cannot be safely projected, persist only error code, byte length and shape hash; never dump raw bytes for convenience.

## Current inventory (seed)

Will be populated by live capture. Example seed:

- arena_primary GET /c/:id — json/read — conversation detail
- arena_primary POST /api/chat — chunked/mutate — chat turn
- arena_primary GET /api/history — json/read — history listing (needs read probe)
- arena_primary WS /ws — websocket/read — streaming

## Adapters

- chat_turn v1.0.0 — chat payload family
- Future: search+citations after one real search-mode capture, code/web outputs after one complete Code session with artifact, images after observable asset capture, video/workflows after real evidence, agent sessions, uploads/derived artifacts
