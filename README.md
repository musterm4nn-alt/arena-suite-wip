# arena-model-archive (private)

Passive, evidence-first archiver for arena.ai conversations: a local
Electron/Chromium macOS app that captures model output streams via CDP
**before** navigation, journals everything into a SQLite (SQLCipher on the
target platform) store with FTS5 search, seals downloaded artifacts with
AES-256-GCM, and exposes **MCP-first** control over a `0600` Unix socket.
The full specification is [`arena-model-archive-plan-ultimate.md`](arena-model-archive-plan-ultimate.md).

> **This repository's rule:** read-only status is earned by probes, never
> claimed. Anything the current environment cannot verify is recorded as
> `blocked_env` with an explicit falsifier — not as a pass. See
> [`docs/platform.md`](docs/platform.md) and `artifacts/gates/*.json`.

## Layout

```
packages/
  core               errors, canonical JSON, sha256, ids, manual clock
  schema             sqlite open/migrations, strict event/witness schemas
  security           fail-closed sanitizer, delete-directive broker
  capture-core       stream assembler, transports, queue, router, completeness
  protocol-catalog   operation lifecycle ladder + drift journaling
  artifacts          sealed blob store (AMABLOB1 + AAD-bound AES-GCM)
  browser-adapter    Adapter interface, mock (CDP-shaped), electron (guarded)
  archive-service    store, capture pipeline, service registry (single source
                     for GUI & MCP), UDS JSON-RPC server
  sync               qualified read walk, checkpoints, coverage reports
  mcp-contract       tool definitions (1:1 with service commands), forbidden list
  analysis           deterministic corpus profiles, golden metric fixtures
  fixtures           synthetic battle/direct/RSC streams, split helpers
apps/
  desktop            witness (isolated world), capture supervisor, headless
                     stack, guarded Electron main
  mcp-bridge         stdio <-> UDS relay for MCP clients
scripts/
  doctor.ts          environment probes -> artifacts/gates/env.json
  gatekit.ts         gate runner: checks + falsifiers -> gate artifacts
  gate-p0/p1/p2/p5   evidence gates (plan §15)
  report-html.ts     render artifacts/gates/*.json -> index.html
```

## Commands

```bash
npm install
npx tsc -p tsconfig.json                                       # typecheck everything
node --experimental-strip-types --no-warnings \
  --test packages/*/src/*.test.ts apps/mcp-bridge/src/*.test.ts  # unit tests
node --experimental-strip-types --no-warnings scripts/doctor.ts
node --experimental-strip-types --no-warnings scripts/gate-p0.ts
node --experimental-strip-types --no-warnings scripts/gate-p1.ts
node --experimental-strip-types --no-warnings scripts/gate-p2.ts
node --experimental-strip-types --no-warnings scripts/gate-p5.ts
node --experimental-strip-types --no-warnings scripts/report-html.ts
```

No build step: everything runs as type-stripped TypeScript (Node ≥ 22.6,
`erasableSyntaxOnly`). No network access is performed by any test or gate.

## Status (sandbox)

| Suite | Result |
| --- | --- |
| `npx tsc -p tsconfig.json` | clean |
| Unit tests, 12 packages | 95 passing, 0 failing |
| P0 attach/target/transport/queue/UTF-8 | 11 headless ✓ · 7 owner checks `blocked_env` |
| P1 vertical slice incl. live MCP socket | 8/8 ✓ |
| P2 full-text capture + sync backfill + golden sweep | 10/10 ✓ |
| P5 MCP parity (44/44 tools) + directive + lock + adversarial | 6/6 ✓ |
| P3/P4/P6/P7 (search UX, encryption, GUI, release) | pending; blocked surfaces listed in `docs/platform.md` |

Reports use Departure Mono (SIL OFL, Helena Zhang) with system monospace
fallback, per plan §18.
