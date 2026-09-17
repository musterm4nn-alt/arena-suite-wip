import { describe, expect, it } from "vitest";
import { CaptureRouter } from "../src/router.js";

const A = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0a";
const B = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0b";

describe("CaptureRouter", () => {
  it("stamps supervisor-derived account identity", () => {
    const r = new CaptureRouter();
    r.bindSession("sess-A", { accountId: A, epochId: "e1" });
    const routed = r.route({
      method: "Network.requestWillBeSent",
      cdpSessionId: "sess-A",
      params: { requestId: "1" },
    });
    expect(routed?.accountId).toBe(A);
    expect(routed?.epochId).toBe("e1");
  });

  it("drops unbound sessions instead of guessing an account", () => {
    const r = new CaptureRouter();
    expect(
      r.route({ method: "Network.requestWillBeSent", cdpSessionId: "nope" }),
    ).toBeNull();
  });

  it("ignores page-supplied account fields (fuzz corpus)", () => {
    const r = new CaptureRouter();
    r.bindSession("sess-A", { accountId: A, epochId: null });
    const hostilePayloads: unknown[] = [
      { accountId: B },
      { account_id: B },
      { nested: { userId: B, deep: { email: "x@y.z" } } },
      [{ owner_id: B }],
      { request: { headers: { Cookie: "session=zzz" }, accountUuid: B } },
      "accountId=B",
      42,
      null,
    ];
    for (const params of hostilePayloads) {
      const routed = r.route({
        method: "Network.requestWillBeSent",
        cdpSessionId: "sess-A",
        params,
      });
      // Database account remains supervisor-derived no matter the payload.
      expect(routed?.accountId).toBe(A);
    }
    // And genuinely hostile objects are flagged:
    const flagged = r.route({
      method: "Network.requestWillBeSent",
      cdpSessionId: "sess-A",
      params: { account_id: B },
    });
    expect(flagged?.payloadAccountFieldIgnored).toBe(true);
  });

  it("keeps two accounts isolated across sessions", () => {
    const r = new CaptureRouter();
    r.bindSession("sess-A", { accountId: A, epochId: "eA" });
    r.bindSession("sess-B", { accountId: B, epochId: "eB" });
    expect(
      r.route({ method: "m", cdpSessionId: "sess-A" })?.accountId,
    ).toBe(A);
    expect(
      r.route({ method: "m", cdpSessionId: "sess-B" })?.accountId,
    ).toBe(B);
    r.unbindSession("sess-A");
    expect(r.route({ method: "m", cdpSessionId: "sess-A" })).toBeNull();
    expect(
      r.route({ method: "m", cdpSessionId: "sess-B" })?.accountId,
    ).toBe(B);
  });
});
