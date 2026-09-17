# Protocol catalog (operator notes)

Implementation: `packages/protocol-catalog`. This doc is operator guidance;
the catalog itself lives in the archive database at runtime.

- **Inventory first, retention narrow.** Every first-party request/response is
  inventoried (`seen`); only payload families required for archive correctness
  get adapters.
- **Unknown stays unknown.** New traffic is never parsed against a guessed
  schema. `direction` starts `unknown`; HTTP verbs prove nothing.
- **Read-only is earned.** `owner_verified_read` is set ONLY by
  `markOwnerVerifiedRead()`, which only the §9.1 probe path calls after
  establishing no-observed-state-change + pagination stability + a detail
  cross-check.
- **Drift fails closed.** Shape-hash changes, missing terminal markers, and
  UI/network disagreement create drift events and downgrade
  `owner_verified_read` → `adapter_ready` until reprobed.
- **RSC is first-class.** Document/RSC responses are classified; discovery is
  not limited to API-looking routes.
