import { describe, it, expect } from "vitest";
import { BoundedQueue } from "./bounded-queue.js";

describe("BoundedQueue", () => {
  it("enqueues until maxSize then drops", () => {
    const q = new BoundedQueue<number>(2, "test");
    expect(q.enqueue(1)).toBe(true);
    expect(q.enqueue(2)).toBe(true);
    expect(q.enqueue(3)).toBe(false);
    const m = q.getMetrics();
    expect(m.enqueued).toBe(2);
    expect(m.dropped).toBe(1);
    expect(m.highWaterMark).toBe(2);
  });

  it("overflowTest reports correctly", () => {
    const q = new BoundedQueue<string>(5, "overflow");
    const res = q.overflowTest(20, (i) => `item-${i}`);
    expect(res.enqueued).toBe(5);
    expect(res.dropped).toBe(15);
  });

  it("drain empties queue", () => {
    const q = new BoundedQueue<number>(10, "drain");
    q.enqueue(1);
    q.enqueue(2);
    const drained = q.drain();
    expect(drained).toEqual([1, 2]);
    expect(q.size()).toBe(0);
  });
});
