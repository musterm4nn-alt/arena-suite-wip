/**
 * @arena/fixtures — synthetic, sanitized protocol fixtures (plan §15 P0/P2).
 *
 * These fixtures are SYNTHETIC: hand-built shapes exercising transport framing
 * (SSE, chunked JSON, WebSocket frames, RSC-like payloads), UTF-8 boundary
 * splits, duplicates, and terminal/partial/failed endings. They carry no real
 * Arena traffic and no secrets. Golden fixtures for real observed shapes are
 * added only from owner-session evidence (see docs/evidence-register.md).
 */

export interface SseRecord {
  event?: string;
  data: string;
}

export function encodeSse(records: SseRecord[]): Uint8Array {
  const text = records
    .map((r) => `${r.event ? `event: ${r.event}\n` : ""}data: ${r.data}\n\n`)
    .join("");
  return new TextEncoder().encode(text);
}

/** A complete synthetic text turn: N content deltas + terminal record. */
export function syntheticTextTurn(deltas: string[]): Uint8Array {
  const records: SseRecord[] = deltas.map((d) => ({
    data: JSON.stringify({ delta: d }),
  }));
  records.push({ data: "[DONE]" });
  return encodeSse(records);
}

/** Split bytes at every combination point in `cuts` (sorted, deduped). */
export function splitAt(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [0, ...new Set(cuts.filter((c) => c > 0 && c < bytes.length)), bytes.length]
    .sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    out.push(bytes.slice(points[i]!, points[i + 1]!));
  }
  return out;
}

/** Every 1-cut split of `bytes` — the hostile UTF-8/record boundary sweep. */
export function everyOneCut(bytes: Uint8Array): Uint8Array[][] {
  const splits: Uint8Array[][] = [];
  for (let cut = 0; cut <= bytes.length; cut++) {
    splits.push(splitAt(bytes, [cut]));
  }
  return splits;
}

/** Minimal incremental SSE parser used ONLY to validate ledger bytes in tests. */
export function parseSse(bytes: Uint8Array): { records: SseRecord[]; terminal: boolean } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const records: SseRecord[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      else if (line.startsWith(":")) continue; // comment/heartbeat
    }
    if (dataLines.length > 0) {
      const rec: SseRecord = { data: dataLines.join("\n") };
      if (event !== undefined) rec.event = event;
      records.push(rec);
    }
  }
  const terminal = records.some((r) => r.data === "[DONE]");
  return { records, terminal };
}

/** Synthetic WebSocket text frames (already-decoded payloads). */
export function syntheticWsFrames(): string[] {
  return [
    JSON.stringify({ type: "start", id: "ws-1" }),
    JSON.stringify({ type: "delta", text: "Hello " }),
    JSON.stringify({ type: "delta", text: "world ✓" }),
    JSON.stringify({ type: "end", reason: "stop" }),
  ];
}

/** Synthetic RSC/Flight-like payload: length-prefixed rows. */
export function syntheticRscPayload(): Uint8Array {
  const rows = ['0:["$","div",null,{"children":"hi"}]', '1:I["app/page",[]]'];
  const text = rows.map((r) => `${r.length.toString(16)}:${r}`).join("\n") + "\n";
  return new TextEncoder().encode(text);
}

/** Multi-byte-heavy string for boundary tests (1..4 byte sequences). */
export const BOUNDARY_TEXT = "aé✓🌍\nZ";
export function boundaryBytes(): Uint8Array {
  return new TextEncoder().encode(BOUNDARY_TEXT);
}
