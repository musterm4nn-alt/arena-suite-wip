import { describe, expect, it } from "vitest";
import { DirectiveBroker } from "../src/directives.js";

const A = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0a";
const B = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0b";

describe("DirectiveBroker", () => {
  it("mints single-use, exact-scope directives", () => {
    let now = 1_000_000;
    const broker = new DirectiveBroker(() => now);
    const d = broker.mint(
      { kind: "conversation", accountId: A, conversationId: "c1" },
      7,
    );
    // Exact scope consumes:
    const ok = broker.consume(d.id, {
      kind: "conversation",
      accountId: A,
      conversationId: "c1",
    });
    expect(ok.ok).toBe(true);
    // Replay fails:
    expect(
      broker.consume(d.id, {
        kind: "conversation",
        accountId: A,
        conversationId: "c1",
      }),
    ).toEqual({ ok: false, code: "E_CONFIRM_REQUIRED" });
    void now;
  });

  it("rejects cross-account and cross-conversation use", () => {
    const broker = new DirectiveBroker(() => 1_000_000);
    const d = broker.mint(
      { kind: "conversation", accountId: A, conversationId: "c1" },
      1,
    );
    // A directive for A cannot delete B:
    expect(
      broker.consume(d.id, {
        kind: "conversation",
        accountId: B,
        conversationId: "c1",
      }),
    ).toEqual({ ok: false, code: "E_CONFIRM_REQUIRED" });
    // ...and the failed consume did not burn the directive:
    expect(
      broker.consume(d.id, {
        kind: "conversation",
        accountId: A,
        conversationId: "c1",
      }).ok,
    ).toBe(true);
  });

  it("expires directives", () => {
    let now = 1_000_000;
    const broker = new DirectiveBroker(() => now);
    const d = broker.mint({ kind: "account", accountId: A }, 3);
    now += 6 * 60 * 1000; // past 5-min TTL
    expect(broker.consume(d.id, { kind: "account", accountId: A })).toEqual({
      ok: false,
      code: "E_CONFIRM_REQUIRED",
    });
  });
});
