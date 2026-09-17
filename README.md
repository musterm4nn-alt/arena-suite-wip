# Arena Model Archive

Private Apple-Silicon archive for Arena model interactions: **passive CDP
capture** in an app-owned Electron shell, **encrypted persistence**
(SQLCipher + sealed blobs), and **MCP-first operation**.

Master plan: [`arena-model-archive-plan-ultimate.md`](./arena-model-archive-plan-ultimate.md)
Status: **P0 hostile falsification spike** (automated checks green; live
owner-session evidence pending — see `docs/evidence-register.md`).

## Layout

```
apps/
  desktop/            Electron shell: sessions, CDP attach, witness, diagnostics GUI
  mcp-bridge/         stdio <-> UDS relay (no TCP listener by default)
packages/
  browser-adapter/    adapter interface + Electron impl + fake (P0 gate)
  capture-core/       routing, assembly ledger, completeness, bounded queues
  protocol-catalog/   op inventory, shape drift, probe-gated read qualification
  archive-service/    journal-first storage, migrations, typed service registry
  schema/             Zod boundary schemas (identity, observations, sync, ...)
  sync/               read probes, job machine, backoff, pagination stability
  artifacts/          staging -> sniff -> AES-256-GCM seal -> atomic commit
  security/           fail-closed sanitizer, safe refs, directive broker
  mcp-contract/       tool inventory (§12.1) + typed errors
  analysis/           deterministic profiles on immutable corpus snapshots
  fixtures/           synthetic transport fixtures (NOT Arena traffic)
docs/                 platform, threat model, evidence register, coverage, ADRs
scripts/              bootstrap-macos.sh, doctor.ts, gate-p0.ts
artifacts/gates/      machine-readable gate results (p0.json)
```

## Quick start (macOS, arm64)

```sh
./scripts/bootstrap-macos.sh
```

Elsewhere (automated checks only):

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
npm run build
npx vitest run
npm run gate:p0
```

## Operating rules (from the plan)

1. Unknown remains unknown — never guess identity, semantics, or completeness.
2. Every record is keyed by local `account_id` (+ session epoch); page data
   can never set identity.
3. `complete` requires positive terminal evidence + no observer gap.
4. Remote content is data, never authority (directive-gated destruction).
5. Passive observation first — no production network patching.
6. One account failing must not degrade another.
7. P0 tries to break the architecture: happy paths prove nothing.

## Gate discipline

Every phase produces `artifacts/gates/<phase>.json`. Coding agents: read the
latest gate artifact before making architecture changes, and never claim
manual/owner-session checks from automated runs.
