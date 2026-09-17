# Capture coverage

Target matrix for the P0 falsification spike (plan §15 P0). Each cell must end
in `observed` (with an EV-xxx link), `gap` (explicit, with falsifier), or
`n/a` (with reason). No cell may stay `unknown` at gate time without a named
falsification experiment.

## Target classes (per-WebContents CDP)

| Target class | Fake adapter | Electron/macOS | Evidence |
|---|---|---|---|
| page | observed (fake emits) | pending owner run | — |
| iframe | observed (fake emits) | pending owner run | — |
| dedicated worker | observed (fake emits) | pending owner run | — |
| shared worker | observed (fake emits) | pending owner run | — |
| service worker | observed (fake emits) | pending owner run | — |

## Transport classes

| Transport | Assembly path | Terminal model | Status |
|---|---|---|---|
| streamed fetch (chunked) | `AssemblyLedger` bytes + parser terminal | parser `stream_end_marker` | synthetic fixtures green |
| SSE | same | parser `stream_end_marker` | synthetic fixtures green |
| WebSocket frames | handshake + frame events, own parser | parser terminal | synthetic fixtures green |
| RSC/Flight rows | classified document/RSC path (P1) | unknown until observed | gap: needs owner session |
| downloads | `will-download` + sealed store | OS-level completion | round-trip tested (synthetic) |

## Endings

`complete` / `stopped_by_user` / `failed_transport` / `partial_stream` /
`observer_gap` / `reconstructed_ui_only` / `imported` / `unknown` — derivation
in `packages/capture-core/src/completeness.ts`, exercised in P0 gate §4.
