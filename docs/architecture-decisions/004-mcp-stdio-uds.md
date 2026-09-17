# ADR 004 — MCP Primary Interface via stdio <-> UDS

**Status:** Accepted
**Date:** 2026-09-17
**Context:** §12 Complete MCP / LLM operation contract.

**Decision:**
- Default transport: tiny stdio bridge process connects to Unix domain socket owned by running archive service, mode 0600. Gives normal MCP client ergonomics without leaving TCP listener.
- Optional Streamable HTTP on 127.0.0.1 may be enabled explicitly for clients that require it; use ephemeral port, bearer token, Host/Origin validation, no CORS, block Arena sessions from loopback.
- Service domains: Accounts, Capture, Sync, Archive, Diagnostics, Analysis, Maintenance — per §12.1.
- Every tool touching account data accepts explicit account IDs or explicit `all` sentinel; never inferred from GUI focus.
- Long work returns job ID and exposes status/cancel/resume. Checkpoints survive restart.
- Cursor pagination for archive reads; opaque identifiers.
- `diagnostics_capabilities` recommended first call, explains unavailable/degraded features rather than hiding tools.
- Typed errors: E_SCOPE_MISMATCH, E_AUTH_EXPIRED, E_OWNER_ACTION_REQUIRED, E_RATE_LIMITED, E_CONFIRM_REQUIRED, E_LOCKED, E_DRIFT, E_UNSUPPORTED, E_PARTIAL, E_BUSY.
- GUI/MCP parity tested in CI by enumerating service commands. No essential workflow GUI-only; owner-attended steps as NEEDS_OWNER_INTERACTION.
- Do not expose generic arbitrary JS, HTTP request, raw SQL, shell execution as MCP tools.

**Rationale:**
- UDS 0600 avoids TCP attack surface by default.
- stdio bridge matches MCP client expectations.
- Explicit account scope prevents cross-account confusion.

**Consequences:**
- Need small mcp-bridge app: stdio <-> UDS relay.
- Need bearer token and Host/Origin validation for optional HTTP.
