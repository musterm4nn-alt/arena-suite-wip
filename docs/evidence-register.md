# Evidence register

Every claim about Arena's behavior that production code depends on must have
an entry here: what was observed, from which account/session, through which
mechanism, when, with what adapter, and what could still be missing.

## Format

| ID | Date | Claim | Mechanism | Adapter | Session | Gaps / falsifiers |
|---|---|---|---|---|---|---|
| … | … | … | … | … | … | … |

## Entries

| ID | Date | Claim | Mechanism | Adapter | Session | Gaps / falsifiers |
|---|---|---|---|---|---|---|
| EV-000 | 2026-09-17 | _None yet._ All protocol shapes in `@arena/fixtures` are synthetic transport-framing exercises, not Arena observations. | n/a | n/a | n/a | P0 owner-session runs populate this table. |

## Rules

- Platform capability does not prove Arena transport usage.
- Bundle/public-route inspection may SEED the protocol catalog (`seen`), but
  only owner-session observations + gates decide production adapters.
- Golden fixtures derived from real traffic must be sanitized (no secrets,
  no account identifiers) and linked to an EV-xxx entry.
