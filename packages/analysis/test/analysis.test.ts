import { describe, expect, it } from "vitest";
import {
  DEFAULT_COHORT,
  corpusHash,
  filterCorpus,
  lexicalMetrics,
  selectExcerpts,
  structureMetrics,
  type CorpusTurn,
} from "../src/index.js";

const T = (over: Partial<CorpusTurn> & { turnId: string }): CorpusTurn => ({
  accountId: "a",
  conversationId: "c",
  completeness: "complete",
  cohort: "revealed:X",
  text: "Hello world.",
  promptHash: null,
  observedAtMs: 0,
  ...over,
});

describe("cohort filtering", () => {
  it("includes only complete turns with known identity by default", () => {
    const turns = [
      T({ turnId: "t1" }),
      T({ turnId: "t2", completeness: "partial_stream" }),
      T({ turnId: "t3", completeness: "observer_gap" }),
      T({ turnId: "t4", cohort: null }),
      T({ turnId: "t5", completeness: "unknown", cohort: null }),
    ];
    expect(filterCorpus(turns, DEFAULT_COHORT).map((t) => t.turnId)).toEqual(["t1"]);
  });

  it("corpus hash is order-stable and content-sensitive", () => {
    const a = [T({ turnId: "t1", text: "x" }), T({ turnId: "t2", text: "y" })];
    const b = [...a].reverse();
    expect(corpusHash(a)).toBe(corpusHash(b));
    expect(corpusHash(a)).not.toBe(corpusHash([T({ turnId: "t1", text: "z" }), a[1]!]));
  });
});

describe("metrics", () => {
  it("computes golden structure metrics", () => {
    const m = structureMetrics(["# Hi\n\nHello world. Bye!\n\n```js\n1\n```\n"]);
    expect(m.sampleCount).toBe(1);
    expect(m.headings).toEqual([1]);
    expect(m.codeBlocks).toEqual([1]);
    expect(m.sentences).toEqual([2]);
    expect(m.codeCharsRatio[0]).toBeGreaterThan(0);
  });

  it("computes lexical metrics deterministically", () => {
    const m = lexicalMetrics(["a a a b? c!"]);
    expect(m.movingTtr).toEqual([3 / 5]);
    expect(m.questionMarks).toEqual([1]);
    expect(m.exclamations).toEqual([1]);
  });

  it("selects excerpts deterministically with turnId tiebreak", () => {
    const turns = [T({ turnId: "b" }), T({ turnId: "a" })];
    expect(selectExcerpts(turns, [1, 1], 2).map((t) => t.turnId)).toEqual(["a", "b"]);
  });
});
