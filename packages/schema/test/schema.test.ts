import { describe, expect, it } from "vitest";
import {
  AccountIdSchema,
  CompletenessSchema,
  ObservationSchema,
  ProtocolOpSchema,
} from "../src/index.js";

describe("schema", () => {
  it("rejects non-UUID account ids (identity must be a stable local UUID)", () => {
    expect(() => AccountIdSchema.parse("owner@example.com")).toThrow();
    expect(() =>
      AccountIdSchema.parse("01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a01"),
    ).not.toThrow();
  });

  it("keeps unknown as an explicit completeness variant", () => {
    expect(CompletenessSchema.options).toContain("unknown");
    expect(CompletenessSchema.options).toContain("complete");
  });

  it("requires account scope on every observation", () => {
    const base = {
      id: "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a01",
      account_id: "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a02",
      session_epoch_id: null,
      mechanism: "cdp-network",
      target_id: "t1",
      cdp_session_id: "s1",
      operation_key: "POST /api/stream",
      adapter_id: null,
      adapter_version: null,
      observed_at_ms: 0,
      completeness: "unknown",
      evidence_ref: null,
      observer_gap: false,
    } as const;
    expect(() => ObservationSchema.parse(base)).not.toThrow();
    const { account_id: _dropped, ...rest } = base;
    expect(() => ObservationSchema.parse(rest)).toThrow();
  });

  it("requires masked path templates on protocol ops", () => {
    const op = {
      id: "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a03",
      host_class: "first-party",
      method: "POST",
      path_template: "/api/c/:id/stream",
      transport: "sse",
      direction: "unknown",
      evidence_state: "seen",
      account_binding_evidence: null,
      payload_family: null,
      shape_hash: null,
      adapter_id: null,
      adapter_version: null,
      completeness_model: null,
      first_seen_ms: 0,
      last_seen_ms: 0,
      drift_counters: {},
    } as const;
    expect(() => ProtocolOpSchema.parse(op)).not.toThrow();
  });
});
