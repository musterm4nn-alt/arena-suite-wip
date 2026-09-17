import { describe, expect, it } from "vitest";
import {
  BOUNDARY_TEXT,
  boundaryBytes,
  encodeSse,
  everyOneCut,
  parseSse,
  syntheticRscPayload,
  syntheticTextTurn,
  syntheticWsFrames,
} from "../src/index.js";

describe("fixtures", () => {
  it("synthetic turn parses with terminal record", () => {
    const bytes = syntheticTextTurn(["Hello ", "world"]);
    const { records, terminal } = parseSse(bytes);
    expect(terminal).toBe(true);
    expect(records.length).toBe(3);
  });

  it("every 1-cut split preserves bytes (lossless sweep)", () => {
    const bytes = encodeSse([{ data: BOUNDARY_TEXT }]);
    for (const parts of everyOneCut(bytes)) {
      const total = parts.reduce((n, p) => n + p.byteLength, 0);
      expect(total).toBe(bytes.byteLength);
      const joined = Buffer.concat(parts.map((p) => Buffer.from(p)));
      expect(joined.toString("utf8")).toBe(Buffer.from(bytes).toString("utf8"));
    }
  });

  it("boundary text covers 1..4 byte sequences", () => {
    expect(boundaryBytes().byteLength).toBeGreaterThan(BOUNDARY_TEXT.length);
  });

  it("ws + rsc fixtures are non-trivial", () => {
    expect(syntheticWsFrames().length).toBe(4);
    expect(syntheticRscPayload().byteLength).toBeGreaterThan(0);
  });
});
