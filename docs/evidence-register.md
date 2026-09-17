# Evidence Register

Every stored statement about ownership, completeness and model identity must answer: what did we observe, from which account/session, through which mechanism, when, with what adapter, and what could still be missing?

## Provenance chain

- Observation: account_id, session_epoch_id, mechanism (cdp_network, cdp_target_lifecycle, isolated_world_witness, download_manager, sync_replay, import), target_id, session_id, operation_key, adapter/version, observed time, completeness state, sanitized evidence ref
- Normalized field: points to one or more observation records
- Derived field: reducer/analysis version and source record IDs
- Identity claims: append-only, scoped to smallest supported turn range/time interval, separate evidence types for participant position, blind label, selected model label, request/catalog identifier, displayed provider/model name, post-vote reveal
- Resolved identity is view, never mutation — precedence may prefer reveal over selected label, but all evidence remains inspectable

## Blocking tests

- Account isolation: Write unique sentinels in A/B and verify no cross-read after restart
- Capture authority: Fuzz page-supplied account-like fields and assert database account remains supervisor-derived
- Session epoch: Sign out A while B streams; A stops, B remains uninterrupted
- Sync: Expire A during concurrent A+B sync; B continues
- Artifacts: Same filename/source URL in two accounts remains two provenance records
- Deletion: A directive for A cannot delete B
- Secret canaries through success/error paths

## Gate artifacts

- artifacts/gates/p0.json — hostile browser/capture falsification spike
- artifacts/gates/p1.json — smallest vertical slice
- etc — each gate produces machine-readable result containing test version, runtime versions, passed/failed checks, measured facts and explicit falsifiers
