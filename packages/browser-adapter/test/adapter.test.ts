import { describe, expect, it } from "vitest";
import { FakeBrowserAdapter } from "../src/fake.js";
import { verifyAttachOrder } from "../src/attach.js";

const A = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0a";
const B = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0b";

describe("attach protocol", () => {
  it("fake attach satisfies attach-before-navigate order", async () => {
    const adapter = new FakeBrowserAdapter();
    const s = await adapter.createSession(A, `/tmp/partitions/${A}`);
    const res = await s.attach("https://arena.ai/");
    expect(res.attachedBeforeNavigate).toBe(true);
    expect(verifyAttachOrder(s.stepLog)).toBeNull();
  });

  it("detects missing steps and order violations", () => {
    expect(verifyAttachOrder([])).toMatch(/missing step/);
    expect(
      verifyAttachOrder(["navigate-arena", "debugger-attach"]),
    ).toMatch(/missing step|order violation/);
  });

  it("exposes the full target matrix (page/iframe/workers/SW)", async () => {
    const adapter = new FakeBrowserAdapter();
    const s = await adapter.createSession(A, `/tmp/partitions/${A}`);
    await s.attach("https://arena.ai/");
    const kinds = (await s.listTargets()).map((t) => t.kind).sort();
    expect(kinds).toEqual([
      "dedicated-worker",
      "iframe",
      "page",
      "service-worker",
      "shared-worker",
    ]);
  });

  it("keeps per-account storage sentinels isolated", async () => {
    const adapter = new FakeBrowserAdapter();
    const a = await adapter.createSession(A, `/tmp/partitions/${A}`);
    const b = await adapter.createSession(B, `/tmp/partitions/${B}`);
    expect(a.sentinel).not.toBe(b.sentinel);
    expect(a.storagePath).not.toBe(b.storagePath);
  });
});
