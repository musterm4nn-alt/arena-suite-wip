# ADR 005 — Completeness Model and Promotion Rules

**Status:** Accepted
**Date:** 2026-09-17
**Context:** §7 Completeness, reconciliation, branches.

**Decision:**
- States: complete, stopped_by_user, failed_transport, partial_stream, observer_gap, reconstructed_ui_only, imported, unknown.
- A turn becomes complete only from positive terminal evidence and absence of known observer gap.
- Later history read may promote partial to complete only if unambiguously covers same account, conversation, branch, revision and reconciles content. Promotion adds provenance event; never overwrites original gap evidence.
- Regeneration, retry, edit create branch/revision relationships; do not replace prior outputs.
- Conversation text never treated as deduplication key.
- Reconnects reconciled using source IDs/event IDs where available plus normalized structural hashes inside same account and revision scope.

**Analysis default:** Only complete included by default; others excluded unless explicitly requested; reconstructed_ui_only excluded from wire-timing claims; imported separate cohort; unknown excluded.

**Consequences:**
- Need assembly ledger with terminal signals, gap intervals.
- Need provenance chain preservation.
- Need explicit coverage reporting for sync.
