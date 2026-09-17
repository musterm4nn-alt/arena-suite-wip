/**
 * Stream assembly ledger chunk — per 6.3
 * Maintain assembly record per logical request/stream: monotonic chunk sequence,
 * byte length, content hash, duplicate count, first/last timestamps, expected content length,
 * transport terminal signal, parser terminal signal, target/session provenance, gap intervals.
 */

export interface Chunk {
  sequence: number;
  byteLength: number;
  hash: string; // sha256 of chunk bytes (hex)
  data: Uint8Array;
  receivedAt: number; // monotonic ms
  isDuplicate: boolean;
}
