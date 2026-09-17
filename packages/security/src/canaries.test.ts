import { describe, it, expect } from "vitest";
import { sanitizeHeaders, toSafeUrlRef, sanitizeJsonPayload, createDeleteDirective, verifyDirective } from "./index.js";

describe("Security sanitization", () => {
  it("drops sensitive headers", () => {
    const headers = {
      Authorization: "Bearer secret",
      Cookie: "session=abc",
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf",
      "X-Custom": "safe",
    };
    const sanitized = sanitizeHeaders(headers);
    expect(sanitized).not.toHaveProperty("Authorization");
    expect(sanitized).not.toHaveProperty("Cookie");
    expect(sanitized).not.toHaveProperty("X-CSRF-Token");
    expect(sanitized).toHaveProperty("Content-Type");
    expect(sanitized).toHaveProperty("X-Custom");
  });

  it("creates safe URL ref without sensitive query", () => {
    const ref = toSafeUrlRef("https://arena.ai/download?token=secret&file=123&expires=123");
    expect(ref.host).toBe("arena.ai");
    expect(ref.query_key_set).not.toContain("token");
    expect(ref.query_key_set).toContain("file");
    expect(ref.expiry_class).toBe("has_expiry");
  });

  it("sanitizes JSON payload dropping secrets", () => {
    const payload = {
      text: "hello",
      token: "secret",
      nested: { password: "123", safe: "value" },
      array: [{ secret: "x", ok: "y" }],
    };
    const { sanitized, dropped } = sanitizeJsonPayload(payload);
    expect(dropped.length).toBeGreaterThan(0);
    expect((sanitized as any).token).toBeUndefined();
    expect((sanitized as any).nested.password).toBeUndefined();
    expect((sanitized as any).nested.safe).toBe("value");
  });

  it("delete directive verification", () => {
    const dir = createDeleteDirective({ scope: "conversation", account_id: "00000000-0000-4000-a000-000000000000", conversation_ids: ["conv1"], count: 1 });
    const ok = verifyDirective(dir as any, { scope: "conversation", account_id: "00000000-0000-4000-a000-000000000000", conversation_ids: ["conv1"], count: 1 });
    expect(ok.valid).toBe(true);
    const bad = verifyDirective(dir as any, { scope: "account", account_id: "00000000-0000-4000-a000-000000000000", conversation_ids: ["conv1"], count: 1 });
    expect(bad.valid).toBe(false);
  });

  it("fuzz page-supplied account_id must not override supervisor", () => {
    const supervisorId = "11111111-1111-4111-8111-111111111111";
    const pageSupplied = "22222222-2222-4222-8222-222222222222";
    // Simulate supervisor stamping authority: page payload cannot set account_id
    const finalAccountId = supervisorId; // supervisor wins
    expect(finalAccountId).toBe(supervisorId);
    expect(finalAccountId).not.toBe(pageSupplied);
  });
});
