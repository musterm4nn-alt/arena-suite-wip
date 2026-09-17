import { describe, expect, it } from "vitest";
import { BoundedCaptureQueue } from "../src/queue.js";

describe("BoundedCaptureQueue", () => {
  it("emits an explicit observer-gap marker on overflow, never silent drops", () => {
    const q = new BoundedCaptureQueue<string>(2, () => 1000);
    expect(q.push("a")).toBeNull();
    expect(q.push("b")).toBeNull();
    const marker = q.push("c");
    expect(marker).toMatchObject({
      type: "observer-gap",
      droppedBatches: 1,
      atMs: 1000,
    });
    expect(q.drain()).toEqual(["b", "c"]);
    expect(q.highWaterMark).toBe(2);
  });

  it("rejects non-positive capacities", () => {
    expect(() => new BoundedCaptureQueue(0)).toThrow();
  });
});
