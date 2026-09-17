import { describe, expect, it } from "vitest";
import {
  sanitizeHeaders,
  sanitizeJson,
  SanitizeError,
  shapeHashOfJson,
  toSafeRef,
} from "../src/sanitize.js";

describe("sanitizeHeaders", () => {
  it("drops secrets entirely (absent, not masked)", () => {
    const out = sanitizeHeaders({
      Authorization: "Bearer abc",
      COOKIE: "session=zzz",
      "X-Csrf-Token": "t",
      "Content-Type": "application/json",
    });
    expect(out).toEqual({ "Content-Type": "application/json" });
    expect("Authorization" in out).toBe(false);
  });
});

describe("sanitizeJson", () => {
  it("drops secret keys at any depth", () => {
    const canary = "CANARY-SECRET-9f8e7d";
    const input = {
      prompt: "hello",
      password: canary,
      nested: { arr: [{ mfaCode: canary, keep: 1 }] },
    };
    const out = JSON.stringify(sanitizeJson(input));
    expect(out).not.toContain(canary);
    expect(out).toContain("hello");
  });

  it("fails closed on unprojectable values", () => {
    expect(() => sanitizeJson({ fn: () => 1 })).toThrow(SanitizeError);
  });

  it("references binary by hash, never inline", () => {
    const out = sanitizeJson({ blob: new Uint8Array([1, 2, 3]) }) as {
      blob: { __binary__: boolean; sha256: string };
    };
    expect(out.blob.__binary__).toBe(true);
    expect(out.blob.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("toSafeRef", () => {
  it("keeps correlation without replay", () => {
    const ref = toSafeRef(
      "https://cdn.arena.ai/files/abc.png?token=S3CR3T&expires=1700000000",
    );
    expect(ref).toMatchObject({
      host: "cdn.arena.ai",
      path: "/files/abc.png",
    });
    if ("ok" in ref) throw new Error("expected SafeRef");
    expect(JSON.stringify(ref)).not.toContain("S3CR3T");
    expect(ref.queryKeySet).toEqual(["expires", "token"]);
    expect(ref.queryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on bad URLs", () => {
    const ref = toSafeRef("::::not a url::::");
    expect(ref).toMatchObject({ ok: false, errorCode: "E_BAD_URL" });
  });
});

describe("shapeHashOfJson", () => {
  it("is stable under key reorder and value change, sensitive to shape change", () => {
    const a = shapeHashOfJson({ x: 1, y: "s" });
    const b = shapeHashOfJson({ y: "other", x: 999 });
    const c = shapeHashOfJson({ x: 1, y: "s", z: true });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
