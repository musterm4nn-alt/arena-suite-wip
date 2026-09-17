import { describe, expect, it } from "vitest";
import { AssemblyLedger } from "../src/ledger.js";

const enc = new TextEncoder();

function splitBytes(bytes: Uint8Array, points: number[]): Uint8Array[] {
  const cuts = [0, ...points, bytes.length].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    out.push(bytes.slice(cuts[i]!, cuts[i + 1]!));
  }
  return out;
}

describe("AssemblyLedger", () => {
  it("reassembles bytes split at every boundary, including mid-UTF8", () => {
    // Mix of 1..4 byte UTF-8 sequences + SSE record framing.
    const text = 'data: héllo 🌍\n\ndata: {"t":"✓"}\n\n';
    const bytes = enc.encode(text);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const parts = splitBytes(bytes, [cut]);
      const ledger = new AssemblyLedger({ streamId: "s", accountId: "a" });
      parts.forEach((b, i) => ledger.append({ seq: i, bytes: b, receivedAtMs: i }));
      expect(Buffer.from(ledger.assembledBytes()).toString("utf8")).toBe(text);
      expect(ledger.hasUnresolvedGap()).toBe(false);
    }
  });

  it("reassembles under 3-way splits at all boundary pairs (sampled)", () => {
    const text = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const bytes = enc.encode(text);
    for (let i = 0; i < bytes.length; i++) {
      for (let j = i; j < bytes.length; j += 3) {
        const parts = splitBytes(bytes, [i, j]);
        const ledger = new AssemblyLedger({ streamId: "s", accountId: "a" });
        // deliver out of order to prove seq ordering
        const order = [2, 0, 1];
        order.forEach((k) =>
          ledger.append({ seq: k, bytes: parts[k]!, receivedAtMs: k }),
        );
        expect(Buffer.from(ledger.assembledBytes()).toString("utf8")).toBe(text);
      }
    }
  });

  it("counts duplicates without double-appending", () => {
    const ledger = new AssemblyLedger({ streamId: "s", accountId: "a" });
    const b = enc.encode("abc");
    expect(ledger.append({ seq: 0, bytes: b, receivedAtMs: 0 })).toBe("accepted");
    expect(ledger.append({ seq: 0, bytes: b, receivedAtMs: 1 })).toBe("duplicate");
    expect(ledger.append({ seq: 0, bytes: b, receivedAtMs: 2 })).toBe("duplicate");
    const snap = ledger.snapshot();
    expect(snap.duplicateCount).toBe(2);
    expect(snap.bytesAccepted).toBe(3);
    expect(Buffer.from(ledger.assembledBytes()).toString()).toBe("abc");
  });

  it("detects implicit sequence gaps", () => {
    const ledger = new AssemblyLedger({ streamId: "s", accountId: "a" });
    ledger.append({ seq: 0, bytes: enc.encode("a"), receivedAtMs: 0 });
    ledger.append({ seq: 5, bytes: enc.encode("b"), receivedAtMs: 1 });
    expect(ledger.hasUnresolvedGap()).toBe(true);
  });

  it("treats recorded gaps and eviction as unresolved", () => {
    const ledger = new AssemblyLedger({ streamId: "s", accountId: "a" });
    ledger.append({ seq: 0, bytes: enc.encode("a"), receivedAtMs: 0 });
    expect(ledger.hasUnresolvedGap()).toBe(false);
    ledger.recordGap({ fromSeq: 1, toSeq: 3, reason: "evicted" });
    expect(ledger.hasUnresolvedGap()).toBe(true);
  });

  it("produces stable content hashes", () => {
    const mk = () => {
      const l = new AssemblyLedger({ streamId: "s", accountId: "a" });
      l.append({ seq: 0, bytes: enc.encode("hello "), receivedAtMs: 0 });
      l.append({ seq: 1, bytes: enc.encode("world"), receivedAtMs: 1 });
      return l.contentHash();
    };
    expect(mk()).toBe(mk());
    expect(mk()).toMatch(/^[0-9a-f]{64}$/);
  });
});
