import { describe, expect, it } from "vitest";
import { ProtocolCatalog, maskPath } from "../src/index.js";

describe("maskPath", () => {
  it("masks identifiers, keeps structure", () => {
    expect(maskPath("/api/c/01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a01/stream")).toBe(
      "/api/c/:id/stream",
    );
    expect(maskPath("/api/page/12345")).toBe("/api/page/:id");
    expect(maskPath("/api/stream")).toBe("/api/stream");
  });
});

describe("ProtocolCatalog", () => {
  it("invents nothing: new traffic is seen/unknown", () => {
    const cat = new ProtocolCatalog(() => 100);
    const op = cat.observe({
      host: "arena.ai",
      method: "post",
      path: "/api/stream",
      transport: "sse",
      observedAtMs: 100,
    });
    expect(op.evidence_state).toBe("seen");
    expect(op.direction).toBe("unknown");
    expect(op.host_class).toBe("first-party");
  });

  it("refuses to grant owner_verified_read without the probe path", () => {
    const cat = new ProtocolCatalog(() => 100);
    cat.observe({
      host: "arena.ai",
      method: "GET",
      path: "/api/history",
      transport: "json",
      observedAtMs: 100,
    });
    expect(() =>
      cat.classify("GET", "/api/history", { evidence_state: "owner_verified_read" }),
    ).toThrow();
    // Probe path works:
    const verified = cat.markOwnerVerifiedRead("GET", "/api/history", "probe-1");
    expect(verified?.evidence_state).toBe("owner_verified_read");
    expect(verified?.direction).toBe("read");
  });

  it("drift invalidates read qualification until reprobed", () => {
    const cat = new ProtocolCatalog(() => 100);
    const op = cat.observe({
      host: "arena.ai",
      method: "GET",
      path: "/api/history",
      transport: "json",
      sampleShape: { items: [1] },
      observedAtMs: 100,
    });
    cat.markOwnerVerifiedRead("GET", "/api/history", "probe-1");
    // Same shape: no drift.
    cat.observe({
      host: "arena.ai",
      method: "GET",
      path: "/api/history",
      transport: "json",
      sampleShape: { items: [2] },
      observedAtMs: 200,
    });
    expect(cat.get("GET", "/api/history")?.evidence_state).toBe("owner_verified_read");
    // Changed shape: drift + downgrade.
    cat.observe({
      host: "arena.ai",
      method: "GET",
      path: "/api/history",
      transport: "json",
      sampleShape: { items: [2], cursor: "x" },
      observedAtMs: 300,
    });
    const after = cat.get("GET", "/api/history");
    expect(after?.evidence_state).toBe("adapter_ready");
    expect(after?.drift_counters["shape-changed"]).toBe(1);
    expect(cat.driftEvents().length).toBe(1);
    void op;
  });
});
