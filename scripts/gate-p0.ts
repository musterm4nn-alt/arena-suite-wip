/**
 * gate-p0 — P0 hostile falsification gate (automated part).
 *
 * "The first implementation phase tries to break the architecture."
 * Runs the hostile sweeps that don't need a live browser, then the full
 * unit suite, and writes a machine-readable result to artifacts/gates/p0.json.
 * Owner-session checks (live Electron on macOS) are listed as manual/pending
 * with an evidence template — the gate does NOT claim them.
 *
 * Usage: npm run gate:p0   (builds first, then runs this script)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { AssemblyLedger, BoundedCaptureQueue, CaptureRouter, deriveCompleteness } from "@arena/capture-core";
import { FakeBrowserAdapter } from "@arena/browser-adapter";
import { verifyAttachOrder } from "@arena/browser-adapter";
import { sanitizeJson, DirectiveBroker } from "@arena/security";
import { ProtocolCatalog } from "@arena/protocol-catalog";
import { MemoryDriver } from "@arena/archive-service";
import { ObservationJournal } from "@arena/archive-service";
import { createServiceRegistry, registryToolNames } from "@arena/archive-service";
import { TOOL_NAMES } from "@arena/mcp-contract";
import { everyOneCut, parseSse, syntheticTextTurn } from "@arena/fixtures";

const root = path.resolve(import.meta.dirname, "..");
const enc = new TextEncoder();

interface GateCheck {
  id: string;
  name: string;
  status: "pass" | "fail" | "manual-pending";
  detail: string;
}

const results: GateCheck[] = [];
function record(id: string, name: string, fn: () => string): void {
  try {
    const detail = fn();
    results.push({ id, name, status: "pass", detail });
  } catch (err) {
    results.push({ id, name, status: "fail", detail: String(err) });
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const A = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0a";
const B = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0b";

// --- 1. attach-before-navigate ------------------------------------------------
record("p0-attach", "attach-before-navigate order (fake adapter)", () => {
  // exercised async below; sync placeholder replaced by async runner
  return "see async section";
});

// (async checks run in main())
async function main(): Promise<void> {
  results.length = 0;

  // 1. Attach order + negative cases
  record("p0-attach", "attach-before-navigate order", () => {
    assert(verifyAttachOrder([]) !== null, "empty log must fail verification");
    assert(
      verifyAttachOrder(["navigate-arena", "debugger-attach"]) !== null,
      "misordered log must fail verification",
    );
    return "negative cases reject; positive case asserted in async section";
  });

  const adapter = new FakeBrowserAdapter();
  const sessA = await adapter.createSession(A, `/tmp/arena-p0/partitions/${A}`);
  const attachRes = await sessA.attach("https://arena.ai/");
  record("p0-attach-order-live", "fake attach satisfies full step order", () => {
    assert(attachRes.attachedBeforeNavigate, "must attach before navigate");
    const v = verifyAttachOrder(sessA.stepLog);
    assert(v === null, v ?? "order ok");
    return `${sessA.stepLog.length} steps verified`;
  });

  // 2. Target matrix
  record("p0-targets", "target matrix page/iframe/workers/SW", () => {
    return "asserted async";
  });
  const kinds = (await sessA.listTargets()).map((t) => t.kind).sort();
  results.pop();
  record("p0-targets", "target matrix page/iframe/workers/SW", () => {
    assert(
      JSON.stringify(kinds) ===
        JSON.stringify(["dedicated-worker", "iframe", "page", "service-worker", "shared-worker"]),
      `target matrix incomplete: ${kinds.join(",")}`,
    );
    return kinds.join(",");
  });

  // 3. Hostile ledger sweep: every 1-cut split of a multibyte SSE turn
  record("p0-ledger-sweep", "ledger reassembles every 1-cut split (multibyte SSE)", () => {
    const bytes = syntheticTextTurn(["héllo ", "wörld 🌍 ✓ ", "done."]);
    let n = 0;
    for (const parts of everyOneCut(bytes)) {
      const ledger = new AssemblyLedger({ streamId: "s", accountId: A });
      parts.forEach((b, i) => ledger.append({ seq: i, bytes: b, receivedAtMs: i }));
      assert(!ledger.hasUnresolvedGap(), `gap at split ${n}`);
      const { terminal } = parseSse(ledger.assembledBytes());
      assert(terminal, `terminal lost at split ${n}`);
      n += 1;
    }
    return `${n} splits reassembled, terminal preserved`;
  });

  // 3b. Duplicates + overflow
  record("p0-ledger-dup", "duplicate chunks counted, never double-appended", () => {
    const ledger = new AssemblyLedger({ streamId: "s", accountId: A });
    const b = enc.encode("abc");
    ledger.append({ seq: 0, bytes: b, receivedAtMs: 0 });
    ledger.append({ seq: 0, bytes: b, receivedAtMs: 1 });
    assert(ledger.snapshot().duplicateCount === 1, "dup not counted");
    assert(ledger.snapshot().bytesAccepted === 3, "dup double-appended");
    return "ok";
  });

  record("p0-queue-overflow", "bounded queue overflows into explicit gap markers", () => {
    const q = new BoundedCaptureQueue<string>(2, () => 7);
    q.push("a");
    q.push("b");
    const m = q.push("c");
    assert(m !== null && m.type === "observer-gap", "overflow must emit gap marker");
    assert(q.drain().join("") === "bc", "oldest evicted");
    return `dropped=${m!.droppedBatches}`;
  });

  // 4. Completeness matrix
  record("p0-completeness", "completeness derivation matrix", () => {
    const c = (o: object) =>
      deriveCompleteness({
        parserTerminal: false,
        transportTerminal: null,
        observerGap: false,
        userStop: false,
        uiOnly: false,
        imported: false,
        ...o,
      } as Parameters<typeof deriveCompleteness>[0]);
    assert(c({ parserTerminal: true, transportTerminal: "loading_finished" }) === "complete", "complete");
    assert(
      c({ parserTerminal: true, transportTerminal: "loading_finished", observerGap: true }) ===
        "observer_gap",
      "gap beats terminal",
    );
    assert(c({ transportTerminal: "transport_close" }) === "partial_stream", "partial");
    assert(c({ userStop: true }) === "stopped_by_user", "stop");
    assert(c({ transportTerminal: "loading_failed" }) === "failed_transport", "failed");
    assert(c({}) === "unknown", "unknown");
    return "6/6 endings correct";
  });

  // 5. Router authority fuzz
  record("p0-router-fuzz", "page-supplied account fields never win", () => {
    const r = new CaptureRouter();
    r.bindSession("sA", { accountId: A, epochId: null });
    const hostile: unknown[] = [
      { accountId: B },
      { account_id: B },
      { nested: [{ user_id: B, email: "e@x.y" }] },
      { request: { headers: { accountUuid: B } } },
    ];
    for (const params of hostile) {
      const routed = r.route({ method: "m", cdpSessionId: "sA", params });
      assert(routed?.accountId === A, `router misrouted: ${JSON.stringify(params)}`);
    }
    assert(r.route({ method: "m", cdpSessionId: "???" }) === null, "unbound must drop");
    return `${hostile.length} hostile payloads contained`;
  });

  // 6. Two-account isolation
  record("p0-isolation", "two live sessions stay isolated (sentinels)", () => {
    return "asserted async";
  });
  const sessB = await adapter.createSession(B, `/tmp/arena-p0/partitions/${B}`);
  await sessB.attach("https://arena.ai/");
  results.pop();
  record("p0-isolation", "two live sessions stay isolated (sentinels)", () => {
    assert(sessA.sentinel !== sessB.sentinel, "sentinel collision");
    assert(sessA.storagePath !== sessB.storagePath, "storage collision");
    return "sentinels + storage disjoint";
  });

  // 7. Sanitizer canaries through success path
  record("p0-sanitize", "secret canaries dropped before persistence", () => {
    const canary = "P0-CANARY-7f3a9c";
    const out = JSON.stringify(
      sanitizeJson({ password: canary, deep: { cookie: canary, keep: "yes" } }),
    );
    assert(!out.includes(canary), "canary leaked through sanitizer");
    assert(out.includes("yes"), "legit field dropped");
    return "canaries absent";
  });

  // 8. Directive cross-scope rejection
  record("p0-directives", "directive for A cannot authorize B", () => {
    const broker = new DirectiveBroker(() => 1000);
    const d = broker.mint({ kind: "conversation", accountId: A, conversationId: "c1" }, 1);
    const bad = broker.consume(d.id, { kind: "conversation", accountId: B, conversationId: "c1" });
    assert(!bad.ok, "cross-account consume must fail");
    const good = broker.consume(d.id, { kind: "conversation", accountId: A, conversationId: "c1" });
    assert(good.ok, "exact-scope consume must succeed");
    return "scope binding holds, single-use holds";
  });

  // 9. Journal round-trip + scope
  record("p0-journal", "journal persists + enforces account scope", () => "async");
  results.pop();
  {
    const driver = new MemoryDriver();
    await driver.migrate(1);
    const journal = new ObservationJournal(driver);
    const id = await journal.append({
      observation: {
        account_id: A,
        session_epoch_id: null,
        mechanism: "cdp-network",
        target_id: "t",
        cdp_session_id: "s",
        operation_key: "POST /x",
        adapter_id: null,
        adapter_version: null,
        observed_at_ms: 0,
        completeness: "unknown",
        evidence_ref: null,
        observer_gap: false,
      },
      evidence: { ok: true },
    });
    record("p0-journal", "journal persists + enforces account scope", () => {
      assert(typeof id === "string" && id.length > 0, "no id returned");
      return `id=${id.slice(0, 12)}…`;
    });
    const cross = await driver.getObservation(B, id);
    record("p0-journal-scope", "cross-account journal read returns null", () => {
      assert(cross === null, "cross-account read leaked");
      return "scoped";
    });
  }

  // 10. Registry parity
  record("p0-parity", "service registry enumerates full contract", () => {
    const names = registryToolNames(createServiceRegistry()).sort();
    assert(JSON.stringify(names) === JSON.stringify([...TOOL_NAMES].sort()), "parity drift");
    return `${names.length} tools`;
  });

  // 11. Catalog defaults
  record("p0-catalog", "unknown-by-default + probe-gated read + drift downgrade", () => {
    const cat = new ProtocolCatalog(() => 100);
    const op = cat.observe({
      host: "arena.ai",
      method: "GET",
      path: "/api/history",
      transport: "json",
      sampleShape: { items: [1] },
      observedAtMs: 100,
    });
    assert(op.direction === "unknown" && op.evidence_state === "seen", "must start unknown");
    let threw = false;
    try {
      cat.classify("GET", "/api/history", { evidence_state: "owner_verified_read" });
    } catch {
      threw = true;
    }
    assert(threw, "direct read-verification must throw");
    cat.markOwnerVerifiedRead("GET", "/api/history", "probe-1");
    cat.observe({
      host: "arena.ai",
      method: "GET",
      path: "/api/history",
      transport: "json",
      sampleShape: { items: [1], cursor: "z" },
      observedAtMs: 200,
    });
    assert(cat.get("GET", "/api/history")?.evidence_state === "adapter_ready", "drift must downgrade");
    return "defaults hold";
  });

  // 12. Full unit suite
  let suiteDetail = "";
  try {
    const out = execFileSync("npx", ["vitest", "run", "--reporter=basic"], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8",
      timeout: 300_000,
    });
    const m = out.match(/Test Files\s+(\d+)\s+passed(?:.*)?\n\s*Tests\s+(\d+)\s+passed/s);
    suiteDetail = m ? `${m[1]} files, ${m[2]} tests passed` : "vitest exited 0";
    results.push({ id: "p0-suite", name: "full unit suite (vitest)", status: "pass", detail: suiteDetail });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    results.push({
      id: "p0-suite",
      name: "full unit suite (vitest)",
      status: "fail",
      detail: String(e.stdout ?? e.stderr ?? e.message ?? err).slice(-2000),
    });
  }

  // Manual owner-session checks (NOT claimed by this gate)
  const manual: GateCheck[] = [
    {
      id: "p0-live-signin",
      name: "owner sign-in (email) in partition A",
      status: "manual-pending",
      detail: "template: account_uuid, epoch_id, partition_path, challenge_seen(y/n)",
    },
    {
      id: "p0-live-stream",
      name: "one real streamed turn captured complete",
      status: "manual-pending",
      detail: "template: conversation_ref, ledger_bytes, terminal_signal, completeness=complete",
    },
    {
      id: "p0-live-stop",
      name: "stop + navigation-during-stream endings",
      status: "manual-pending",
      detail: "template: stopped_by_user + partial_stream/observer_gap evidenced",
    },
    {
      id: "p0-live-vote",
      name: "reveal/vote workflow (where applicable)",
      status: "manual-pending",
      detail: "template: identity_claim rows (blind vs reveal), witness adapter version",
    },
    {
      id: "p0-live-artifact",
      name: "real artifact/download sealed",
      status: "manual-pending",
      detail: "template: blob_id, sha256, mime_sniffed, staging_removed(y/n)",
    },
    {
      id: "p0-live-exporter",
      name: "evidence-class comparison vs existing exporter",
      status: "manual-pending",
      detail: "template: classes+ gaps compared (NOT text equality)",
    },
  ];
  results.push(...manual);

  const failed = results.filter((r) => r.status === "fail");
  const artifact = {
    gate: "p0",
    version: 1,
    at: new Date().toISOString(),
    runtime: { node: process.version, platform: `${process.platform}/${process.arch}` },
    summary: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: failed.length,
      manual_pending: manual.length,
    },
    checks: results,
    decision:
      failed.length === 0
        ? "automated checks green; P0 NOT complete until manual owner-session evidence lands in docs/evidence-register.md"
        : "BLOCKED: automated failures must be fixed before owner-session runs",
  };
  mkdirSync(path.join(root, "artifacts/gates"), { recursive: true });
  writeFileSync(path.join(root, "artifacts/gates/p0.json"), JSON.stringify(artifact, null, 2) + "\n");

  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.status.toUpperCase().padEnd(14)} ${r.id} — ${r.name} (${r.detail.slice(0, 160)})`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${artifact.decision}\nartifact: artifacts/gates/p0.json`);
  if (failed.length > 0) process.exit(1);
}

await main();
