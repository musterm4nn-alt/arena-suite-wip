import { createHash } from 'node:crypto';
import { sha256Hex } from '@arena/core';
import { Utf8StreamDecoder } from './utf8.ts';

/**
 * Stream assembly ledger (plan §6.3): per logical request/stream we maintain
 * monotonic chunk sequence, byte length, content hash, duplicate count,
 * first/last timestamps, expected length when known, transport + parser
 * terminal signals, provenance, and gap intervals. Replayed chunks are counted
 * but never appended twice.
 */

export interface ChunkInput {
  seq: number;            // monotonic per-request sequence as observed
  bytes: Uint8Array;
  at: number;             // epoch ms
  dedupeKey?: string;     // when the transport provides ids (ws/sse event ids)
}

export interface AssemblyRecord {
  requestId: string;
  accountId: string;
  targetId?: string;
  cdpSessionId?: string;
  firstSeq: number | null;
  lastSeq: number | null;
  chunkCount: number;      // appended (deduplicated) chunks
  duplicateCount: number;  // counted but not appended
  gapCount: number;
  gapIntervals: { fromSeq: number; toSeq: number }[];
  receivedBytes: number;   // raw bytes seen, incl. duplicates
  assembledBytes: number;  // bytes actually appended
  expectedBytes: number | null;
  transportTerminal: 'finished' | 'failed' | 'abandoned' | null;
  transportError?: string;
  parserTerminal: 'done' | null;  // logical terminal, e.g. SSE [DONE]
  startedAt: number | null;
  endedAt: number | null;
  outOfOrderSeqs: number[];
  bodySha256: string | null;
}

export class StreamAssembler {
  #state = new Map<string, InternalState>();
  #opts: { maxAssembledBytes: number };

  constructor(opts: { maxAssembledBytes: number }) { this.#opts = opts; }

  #ensure(id: string, init: Partial<Pick<AssemblyRecord, 'accountId' | 'targetId' | 'cdpSessionId' | 'expectedBytes'>>): InternalState {
    let s = this.#state.get(id);
    if (!s) {
      s = new InternalState(id, init.accountId ?? 'unknown', init.expectedBytes ?? null);
      s.record.targetId = init.targetId;
      s.record.cdpSessionId = init.cdpSessionId;
      this.#state.set(id, s);
    }
    return s;
  }

  begin(requestId: string, init: { accountId: string; targetId?: string; cdpSessionId?: string; expectedBytes?: number | null }): void {
    this.#ensure(requestId, { ...init, expectedBytes: init.expectedBytes ?? null });
  }

  appendChunk(requestId: string, chunk: ChunkInput, meta?: { accountId?: string; targetId?: string; cdpSessionId?: string }): 'appended' | 'duplicate' {
    const s = this.#ensure(requestId, { accountId: meta?.accountId ?? 'unknown', targetId: meta?.targetId, cdpSessionId: meta?.cdpSessionId });
    return s.append(chunk);
  }

  transportFinished(requestId: string, at: number): void {
    const s = this.#ensure(requestId, {});
    s.record.transportTerminal = 'finished';
    s.record.endedAt = at;
  }

  transportFailed(requestId: string, at: number, error: string): void {
    const s = this.#ensure(requestId, {});
    s.record.transportTerminal = 'failed';
    s.record.transportError = error;
    s.record.endedAt = at;
  }

  /** Context loss (renderer gone / navigated away): not a transport failure of this response. */
  abandon(requestId: string, at: number, reason: string): void {
    const s = this.#ensure(requestId, {});
    s.record.transportTerminal = 'abandoned';
    s.record.transportError = reason;
    s.record.endedAt = at;
  }

  parserDone(requestId: string): void {
    const s = this.#ensure(requestId, {});
    s.record.parserTerminal = 'done';
  }

  note(requestId: string, kind: 'overflow_gap' | 'late_bytes', at?: number): void {
    const s = this.#ensure(requestId, {});
    s.gapFlags.add(kind);
    if (at !== undefined) s.record.endedAt = Math.max(s.record.endedAt ?? 0, at);
  }

  snapshot(requestId: string): AssemblyRecord | undefined {
    const s = this.#state.get(requestId);
    return s ? s.export() : undefined;
  }

  /** Finalize keeps a sealed record so late bytes after close are counted, never appended. */
  finalize(requestId: string): { record: AssemblyRecord; text: string } {
    const s = this.#ensure(requestId, {});
    return s.finalize();
  }

  activeRequestIds(): string[] {
    return [...this.#state.entries()].filter(([, v]) => !v.sealed).map(([k]) => k);
  }
  sealedRequestIds(): string[] {
    return [...this.#state.entries()].filter(([, v]) => v.sealed).map(([k]) => k);
  }
  drop(requestId: string): void { this.#state.delete(requestId); }
}

class InternalState {
  record: AssemblyRecord;
  #chunks: Uint8Array[] = [];
  #decoder = new Utf8DecoderHolder();
  #seenKeys = new Set<string>();
  #bySeq = new Map<number, string>();
  #hash = createHash('sha256');
  #finalText: string | null = null;
  #finalized = false;
  sealed = false;
  gapFlags = new Set<string>();

  constructor(requestId: string, accountId: string, expectedBytes: number | null) {
    this.record = {
      requestId,
      accountId,
      firstSeq: null,
      lastSeq: null,
      chunkCount: 0,
      duplicateCount: 0,
      gapCount: 0,
      gapIntervals: [],
      receivedBytes: 0,
      assembledBytes: 0,
      expectedBytes,
      transportTerminal: null,
      parserTerminal: null,
      startedAt: null,
      endedAt: null,
      outOfOrderSeqs: [],
      bodySha256: null,
    };
  }

  append(chunk: ChunkInput): 'appended' | 'duplicate' {
    if (this.#finalized) {
      // Late bytes after finalize: count, never corrupt the sealed body.
      this.gapFlags.add('late_bytes');
      this.record.receivedBytes += chunk.bytes.length;
      return 'duplicate';
    }
    this.record.receivedBytes += chunk.bytes.length;
    const contentHash = sha256Hex(chunk.bytes);
    const key = chunk.dedupeKey ?? `${chunk.seq}:${contentHash}`;
    const seqReplay = this.#bySeq.get(chunk.seq) === contentHash;
    if (this.#seenKeys.has(key) || seqReplay) {
      this.record.duplicateCount++;
      return 'duplicate';
    }
    this.#seenKeys.add(key);
    if (!this.#bySeq.has(chunk.seq)) this.#bySeq.set(chunk.seq, contentHash);

    if (this.record.firstSeq === null) {
      this.record.firstSeq = chunk.seq;
      this.record.startedAt = chunk.at;
    } else if (this.record.lastSeq !== null) {
      if (chunk.seq <= this.record.lastSeq) {
        this.record.outOfOrderSeqs.push(chunk.seq);
      } else if (chunk.seq > this.record.lastSeq + 1) {
        this.record.gapCount++;
        this.record.gapIntervals.push({ fromSeq: this.record.lastSeq + 1, toSeq: chunk.seq - 1 });
      }
    }
    this.record.lastSeq = Math.max(this.record.lastSeq ?? chunk.seq, chunk.seq);
    this.record.chunkCount++;
    this.#chunks.push(chunk.bytes);
    this.#hash.update(Buffer.from(chunk.bytes));
    this.record.assembledBytes += chunk.bytes.length;
    this.#decoder.push(chunk.bytes);
    return 'appended';
  }

  export(): AssemblyRecord {
    return { ...this.record, gapIntervals: [...this.record.gapIntervals], outOfOrderSeqs: [...this.record.outOfOrderSeqs] };
  }

  finalize(): { record: AssemblyRecord; text: string } {
    if (this.#finalized && this.#finalText !== null) {
      return { record: this.export(), text: this.#finalText };
    }
    const { tail, truncated } = this.#decoder.finish();
    if (truncated) this.gapFlags.add('utf8_truncated');
    const text = this.#decoder.all + tail;
    this.#finalText = text;
    this.#finalized = true;
    this.sealed = true;
    this.record.bodySha256 = this.#hash.digest('hex');
    for (const g of this.gapFlags) {
      if (!this.record.gapIntervals.some((gi) => gi.fromSeq === -1)) void g; // flags kept separately
    }
    const rec = this.export();
    rec.gapCount += [...this.gapFlags].filter((f) => f === 'overflow_gap' || f === 'utf8_truncated' || f === 'late_bytes').length;
    return { record: rec, text };
  }
}

/** Decoder that accumulates decoded text while tolerating split boundaries. */
class Utf8DecoderHolder {
  #decoder = new Utf8StreamDecoder();
  #text = '';
  push(b: Uint8Array): void { this.#text += this.#decoder.push(b); }
  get all(): string { return this.#text; }
  get pendingBytes(): number { return this.#decoder.pendingBytes; }
  finish(): { tail: string; truncated: boolean } {
    const tailText = this.#decoder.finish();
    if (tailText.tail) this.#text += tailText.tail;
    return tailText;
  }
}

/**
 * Byte-budget guard: assembly refuses to buffer beyond the configured cap so a
 * hostile/huge stream cannot exhaust the process. Overflow is an *explicit*
 * observer_gap condition, never a silent trim.
 */
export class AssemblyBudget {
  #used = 0;
  #maxBytes: number;
  constructor(maxBytes: number) { this.#maxBytes = maxBytes; }
  tryReserve(n: number): boolean {
    if (this.#used + n > this.#maxBytes) return false;
    this.#used += n;
    return true;
  }
  release(n: number): void { this.#used = Math.max(0, this.#used - n); }
  get used(): number { return this.#used; }
}
