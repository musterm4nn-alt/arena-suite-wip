# Capture Coverage

## Witness System

Three-witness: passive network, target lifecycle, isolated-world rendered-state.

### Primary Passive Network Witness

- `Network.requestWillBeSent`, `responseReceived`, `dataReceived`, `loadingFinished`, `loadingFailed`
- For streaming ops, `Network.streamResourceContent` early + assemble buffered bytes + later chunks. At completion, `Network.getResponseBody` as reconciliation where appropriate.
- WebSocket handshake/frame events and EventSource message events independently; never force all through one parser.
- `Fetch` response interception only for specific qualified payload family when passive Network proven insufficient. Not default.
- Every event routed by sessionId/targetId, then stamped with account_id + session_epoch_id before shared queue.

### Stream Assembly Ledger

Per logical request/stream:
- monotonic chunk seq, byte length, content hash, duplicate count, first/last ts, expected content length when known, transport terminal signal, parser terminal signal, target/session provenance, gap intervals
- replayed chunks counted not appended twice
- UTF-8 and logical record boundaries tested under arbitrary chunk splitting

### Rendered-state Witness

Isolated-world witness records only UI facts unavailable or more authoritative in rendered state:
- route/conversation reference, participant positions, blind labels, selected labels, visible vote state, reveal banners, stop/error state, UI ordering
- Typed observations through one binding, no privileged return channel
- DOM selectors versioned adapters with drift counters

## Completeness

| State | Meaning | Analysis default |
| --- | --- | --- |
| complete | Positive terminal evidence and no unresolved observer gap at ending | Included |
| stopped_by_user | Owner/client abort evidence exists | Excluded unless explicitly requested |
| failed_transport | Transport/protocol failure ended turn | Excluded |
| partial_stream | Content exists but stream ended without valid terminal signal | Excluded |
| observer_gap | App knows observation was absent/evicted while output may have occurred | Excluded |
| reconstructed_ui_only | Only rendered-state evidence exists | Excluded from wire-timing claims |
| imported | Imported from prior archive/export | Separate cohort by default |
| unknown | State cannot be established | Excluded |

Later history read may promote partial to complete only if unambiguously covers same account/conversation/branch/revision and reconciles content. Promotion adds provenance event; never overwrites original gap evidence.

## P0 Falsification Checklist

- [ ] Attach/domain-enable occurs before first Arena navigation request
- [ ] Page, iframe, dedicated worker, shared worker, service-worker target creation exercised; freeze/arm/resume child targets
- [ ] Navigation and renderer process loss during streams forced
- [ ] Synthetic stream records split at every UTF-8/logical boundary; duplicate chunks replayed; bounded queues overflowed deliberately
- [ ] Streamed fetch, SSE, WebSocket, RSC-like payload, partial/stopped/failed outcomes, download start exercised
- [ ] Two accounts simultaneously with distinct storage/network sentinels
- [ ] Owner-session: email sign-in, one real streamed turn, one stop/failure, one navigation during stream, one reveal/vote workflow, one real artifact/download where available
- [ ] Compare evidence classes and gaps vs existing exporter where practical

## Known Gaps (to be filled by gate results)

- TBD after P0 run: document measured facts, explicit falsifiers in `artifacts/gates/p0.json`
