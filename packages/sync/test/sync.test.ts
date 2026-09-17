import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  canTransition,
  checkPaginationStability,
  evaluateReadProbe,
  isRetryableClass,
  transitionJob,
} from "../src/index.js";

describe("read probe", () => {
  const base = {
    probeId: "p1",
    accountId: "a",
    operationKey: "GET /api/history",
    fingerprintBefore: "fp1",
    fingerprintAfter: "fp1" as string | null,
    equivalenceEstablished: true,
    paginationStable: true,
    detailCrossChecked: true,
  };
  it("qualifies only on full equivalence", () => {
    expect(evaluateReadProbe(base).verdict).toBe("qualified");
  });
  it("fingerprint change => mutation_unknown (blocks replay)", () => {
    expect(evaluateReadProbe({ ...base, fingerprintAfter: "fp2" }).verdict).toBe(
      "mutation_unknown",
    );
  });
  it("unestablished equivalence => mutation_unknown", () => {
    expect(evaluateReadProbe({ ...base, equivalenceEstablished: false }).verdict).toBe(
      "mutation_unknown",
    );
  });
  it("missing after-fingerprint => failed", () => {
    expect(evaluateReadProbe({ ...base, fingerprintAfter: null }).verdict).toBe("failed");
  });
});

describe("job machine", () => {
  it("enforces legal transitions", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("completed", "running")).toBe(false);
    expect(() =>
      transitionJob(
        { id: "j", accountId: "a", state: "completed", blockingReason: "none", consecutiveFailures: 0 },
        "running",
      ),
    ).toThrow();
  });
});

describe("backoff", () => {
  it("is bounded and deterministic-safe", () => {
    const d1 = backoffDelayMs(1, undefined, () => 0);
    const d8 = backoffDelayMs(8, undefined, () => 0.999);
    expect(d1).toBeGreaterThanOrEqual(500);
    expect(d8).toBeLessThanOrEqual(60_000);
    expect(backoffDelayMs(9)).toBeNull();
  });
  it("never retries auth or suspected mutation", () => {
    expect(isRetryableClass("auth")).toBe(false);
    expect(isRetryableClass("suspected_mutation")).toBe(false);
    expect(isRetryableClass("rate_limited")).toBe(true);
  });
});

describe("pagination", () => {
  it("detects instability on fingerprint or cursor drift", () => {
    const p = { fingerprint: "f", cursor: "c", itemCount: 10 };
    expect(checkPaginationStability(p, { ...p })).toBe("stable");
    expect(checkPaginationStability(p, { ...p, fingerprint: "g" })).toBe(
      "pagination_instability",
    );
  });
});
