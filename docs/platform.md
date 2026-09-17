# Arena Model Archive — Platform & Evidence Register

This document records **what has been verified where**, per the plan's rule:
*read-only status must be earned by probes; unknown remains unknown.*
It is the authoritative list of which surfaces are proven in this sandbox and
which are honestly blocked pending an arm64 macOS owner environment. Nothing
here upgrades a blocked surface to "works" without a passing check on the
target platform.

Companion machine-readable artifacts: `artifacts/gates/*.json`
(render: `node scripts/report-html.ts` → `artifacts/gates/index.html`).

## 1. Environment probes (`scripts/doctor.ts` → `artifacts/gates/env.json`)

| Probe | Sandbox result | Consequence |
| --- | --- | --- |
| `node:sqlite` availability | available, FTS5 enabled | storage engine + search exercised here |
| WAL + `synchronous=FULL` journaling | available | durability semantics testable |
| SQLCipher native binding | **absent** | encryption-at-rest is `blocked_env`; DB here is plaintext with capability flag `dbEncrypted:false` (reported, never silently assumed) |
| macOS Keychain | **absent** (non-macOS host) | key wrapping exercised via `FileKeyWrapper` file-backed stand-in only |
| Electron runtime | **absent** | all owner-session checks `blocked_env` |

## 2. Verified in this sandbox (unit tests + gates)

| Layer | Evidence |
| --- | --- |
| Canonical JSON / SHA-256 / typed errors / manual clock | `packages/core` tests (7) |
| Migration ladder v1–v3, strict event schemas, WAL config | `packages/schema` tests (8) |
| Fail-closed sanitizer (depth/size/secret patterns), directive broker (single-use, scope-bound, 64-hex) | `packages/security` tests (7) |
| UTF-8 byte-split decoder, stream assembler (dup replay, gap, terminal priority), queue overflow→gap, event routing, completeness ladder (`complete/partial_stream/stopped_by_user/failed_transport/ui_only/observer_gap/imported/unknown`), attach-before-navigate verification, wire↔witness reconciliation, context-loss (abandon) rules | `packages/capture-core` tests (20) |
| Protocol catalog lifecycle ladder, `owner_verified_read` gating, drift demotion | `packages/protocol-catalog` tests (10) |
| Artifact seal (AMABLOB1, AAD-bound AES-256-GCM), file-wrapped keys, staged write→db-commit | `packages/artifacts` tests (8) |
| Archive pipeline: journal-first writes, conv/branch/turn/part rows, identity claims append-only with `resolved` view precedence, tombstones, export/import integrity, lock semantics | `packages/archive-service` tests (7) |
| Sync: read-qualification ladder, mutation_unknown on replay≥400, sticky cursor, drift→conflict + step-back, backoff on 429/5xx, coverage "not a completeness claim" | `packages/sync` tests (12) |
| MCP contract: tool table parity with the single service registry; forbidden surfaces (`eval_js`, raw SQL, HTTP fetch, shell, directive mint) absent from both surfaces | `packages/mcp-contract` tests (4) |
| Analysis: corpus selection (complete ∧ observed cohort), corpus/code-version hash sensitivity, 13 deterministic metrics, golden opener-pattern separation, compare refuses mismatched corpora | `packages/analysis` tests (6) |
| MCP bridge stdio↔UDS relay incl. live-socket JSON-RPC roundtrip | `apps/mcp-bridge` tests (2) |
| **P0 gate**: attach order, target matrix, every-boundary UTF-8 split, duplicate replay, queue overflow, transport matrix (SSE/NDJSON/RSC/WS), completeness outcomes, navigation/crash disruption, two-account isolation, DevTools hazard, download sealing — 11/11 headless | `artifacts/gates/p0.json` |
| **P1 gate**: vertical slice — capture → crash-partial → MCP transcript query over **real UDS socket** → provenance → canary scan of raw DB bytes → directive delete → restart durability — 8/8 | `artifacts/gates/p1.json` |
| **P2 gate**: battle/direct/side-by-side modes, post-vote reveal claims, branch/regen isolation, promotion rules, worker-target capture, UI↔wire conflict recording, qualified backfill walk with idempotent replay, 36-way golden split sweep, download↔artifact linkage — 10/10 | `artifacts/gates/p2.json` |
| **P5 gate**: 44/44 contract tools execute via `tools/call`, surface parity + forbidden absence, conservative lock semantics, directive scope binding + single-use, adversarial archived text inert — 6/6 | `artifacts/gates/p5.json` |

## 3. Blocked surfaces (require the real platform; never faked)

Each check exists in a gate file with status `blocked_env` and a falsifier
naming what would disprove the claim. All are blocked because this sandbox has
no Electron host, no owner Arena session, and no macOS keychain.

| ID | Surface | Unblock requires |
| --- | --- | --- |
| `owner_signin` | real sign-in flow, attach-before-navigate on production login | packaged app on arm64 macOS + owner account |
| `owner_real_stream` | live SSE/RSC battle stream capture vs real UI; catalog drift detection against production payloads | same |
| `owner_stop` | Stop-generation button → `stopped_by_user` classification on real transport | same |
| `owner_reveal` | post-vote reveal capture from real DOM/witness selectors (`data-arena-*` existence itself is unverified here) | same |
| `owner_download` | `will-download` sealing against real artifacts incl. byte-identity with browser's own file | same |
| `exporter_compare` | completeness parity vs community exporters on the same account | owner export + this app on macOS |
| `chromium_target_coverage` | service workers, shared workers, popups, OOPIFs on real Electron/Chromium target tree | same |
| `db_encryption` | SQLCipher FIPS path, key rotation, locked-DB error surface | SQLCipher binding (electron rebuild) |
| `keychain_wrap` | Keychain-backed wrapping of the archive key; transient-exposure window in §7 | macOS Keychain |
| GUI shell | window creation, tray, renderer chrome. Parity is structural (one registry) and MCP-side behavior is fully executed in P5; the Electron chrome itself is unrun here | packaged app |

**Explicit unknowns** (no claim either way): production Arena DOM selectors,
RSC flight payload shape, real SSE framing quirks, Electron session-partition
isolation edge cases, macOS notification/permissions surfaces. The witness and
catalog degrade to `unknown`/drift-journaling when these mismatch — they never
guess.

## 4. Design decisions worth knowing

- `@arena/core` is an added shared-primitive layer (plan §17 lists a
  "recommended" layout); every error code, hash, and clock flows through it.
- The Electron entry (`apps/desktop/src/main.ts`) is guarded: importing it is
  type-checked but bootstrapping outside a packaged macOS app throws by design,
  so no test can accidentally claim it ran.
- The Arena-view renderer has **no preload API by construction** (§6 rule);
  the witness posts only typed observations through an isolated-world binding.
- Maintenance lock is conservative: while locked, only `diagnostics_*`,
  `archive_export`, backup/lock/unlock are answerable; even reads like
  `archive_search` return `E_LOCKED` (P5 pins this).
- Conversations are keyed by observed `external_ref` when present, and by
  minted local ids when not — identity is never inferred from UI focus (§2).
- Sync checkpoints persist `sync_job` rows so crash-resume across process
  restarts is FK-checked, not best-effort.

## 5. Running gates on the target platform

```bash
npm install
npx tsc -p tsconfig.json
node --experimental-strip-types --no-warnings --test packages/*/src/*.test.ts
node --experimental-strip-types --no-warnings scripts/doctor.ts      # env.json
node --experimental-strip-types --no-warnings scripts/gate-p0.ts     # + owner checks unlock when runtime present
node --experimental-strip-types --no-warnings scripts/gate-p1.ts
node --experimental-strip-types --no-warnings scripts/gate-p2.ts
node --experimental-strip-types --no-warnings scripts/gate-p5.ts
node --experimental-strip-types --no-warnings scripts/report-html.ts  # artifacts/gates/index.html
```

Gate runners read capability flags from the stack (`adapterKind`,
`dbEncrypted`, `ownerSessionVerified`) and emit `blocked_env` — not passes —
for any check whose precondition the environment cannot provide. On a real
macOS host with the packaged app, the same checks execute headlessly over the
UDS and their results overwrite the blocked entries in the artifacts.
