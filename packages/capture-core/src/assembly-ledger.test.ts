import { describe, it, expect } from "vitest";
import { StreamAssemblyLedger } from "./assembly-ledger.js";

describe("StreamAssemblyLedger", () => {
  it("assembles chunks in order", () => {
    const ledger = new StreamAssemblyLedger();
    const reqId = "req-1";
    ledger.createRecord({ id: reqId, account_id: "acc", session_epoch_id: "epoch", request_id: reqId, target_provenance: {} });
    ledger.appendChunk(reqId, { seq: 0, bytes: new TextEncoder().encode("Hello "), timestamp: Date.now() });
    ledger.appendChunk(reqId, { seq: 1, bytes: new TextEncoder().encode("world"), timestamp: Date.now() });
    const rec = ledger.getRecord(reqId);
    expect(new TextDecoder().decode(rec?.assembled)).toBe("Hello world");
  });

  it("counts duplicates but not double-appends", () => {
    const ledger = new StreamAssemblyLedger();
    const reqId = "req-dup";
    ledger.createRecord({ id: reqId, account_id: "acc", session_epoch_id: "epoch", request_id: reqId, target_provenance: {} });
    ledger.appendChunk(reqId, { seq: 0, bytes: new TextEncoder().encode("A"), timestamp: Date.now() });
    ledger.appendChunk(reqId, { seq: 0, bytes: new TextEncoder().encode("A"), timestamp: Date.now() });
    const rec = ledger.getRecord(reqId);
    expect(rec?.duplicate_count).toBe(1);
    expect(new TextDecoder().decode(rec?.assembled)).toBe("A");
  });

  it("detects gaps", () => {
    const ledger = new StreamAssemblyLedger();
    const reqId = "req-gap";
    ledger.createRecord({ id: reqId, account_id: "acc", session_epoch_id: "epoch", request_id: reqId, target_provenance: {} });
    ledger.appendChunk(reqId, { seq: 0, bytes: new TextEncoder().encode("A"), timestamp: Date.now() });
    ledger.appendChunk(reqId, { seq: 2, bytes: new TextEncoder().encode("C"), timestamp: Date.now() });
    const rec = ledger.getRecord(reqId);
    expect(rec?.gap_intervals.length).toBe(1);
    expect(rec?.gap_intervals[0].start_seq).toBe(1);
  });

  it("splits at UTF-8 boundaries correctly", () => {
    const text = "café 🎉";
    const { chunks } = StreamAssemblyLedger.splitAtUtf8Boundaries(text);
    const reassembled = new TextDecoder().decode(new Uint8Array(chunks.reduce((acc, c) => [...acc, ...c], [] as number[])));
    // reassembled via concatenation of chunks should equal original
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const assembled = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) { assembled.set(c, offset); offset += c.length; }
    expect(new TextDecoder().decode(assembled)).toBe(text);
  });
});
