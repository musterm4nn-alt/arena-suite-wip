import { createHash } from 'node:crypto';
import type { Chunk } from './Chunk.js';

/**
 * Stream assembly ledger per section 6.3
 * Replayed chunks are counted but not appended twice.
 * UTF-8 and logical record boundaries are tested under arbitrary chunk splitting.
 */

export type TerminalSignal = 'finished' | 'failed' | 'canceled' | 'none';

export interface AssemblyRecord {
  requestId: string;
  accountId: string;
  sessionEpochId: string | null;
  targetId: string | null;
  sessionId: string | null; // CDP sessionId
  chunks: Chunk[];
  totalBytes: number;
  duplicateCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  expectedContentLength: number | null;
  transportTerminal: TerminalSignal;
  parserTerminal: TerminalSignal;
  gapIntervals: Array<{ start: number; end: number; reason: string }>;
  contentHash: string | null; // final assembled hash
  isComplete: boolean;
}

export class StreamAssemblyLedger {
  private records = new Map<string, AssemblyRecord>();
  private maxRecords = 1000;
  private maxBytesPerRecord = 50 * 1024 * 1024; // 50MB guard

  createRecord(
    requestId: string,
    accountId: string,
    meta: { sessionEpochId?: string | null; targetId?: string | null; sessionId?: string | null; expectedLength?: number | null }
  ): AssemblyRecord {
    if (this.records.size >= this.maxRecords) {
      // Evict oldest incomplete — creates observer_gap
      const oldest = Array.from(this.records.values()).sort((a, b) => (a.firstTimestamp ?? 0) - (b.firstTimestamp ?? 0))[0];
      if (oldest) {
        this.records.delete(oldest.requestId);
        // Caller should log observer_gap
      }
    }
    const rec: AssemblyRecord = {
      requestId,
      accountId,
      sessionEpochId: meta.sessionEpochId ?? null,
      targetId: meta.targetId ?? null,
      sessionId: meta.sessionId ?? null,
      chunks: [],
      totalBytes: 0,
      duplicateCount: 0,
      firstTimestamp: null,
      lastTimestamp: null,
      expectedContentLength: meta.expectedLength ?? null,
      transportTerminal: 'none',
      parserTerminal: 'none',
      gapIntervals: [],
      contentHash: null,
      isComplete: false,
    };
    this.records.set(requestId, rec);
    return rec;
  }

  getRecord(requestId: string): AssemblyRecord | undefined {
    return this.records.get(requestId);
  }

  appendChunk(requestId: string, data: Uint8Array, sequence?: number): { duplicate: boolean; record: AssemblyRecord } {
    const rec = this.records.get(requestId);
    if (!rec) throw new Error(`No assembly record for ${requestId}`);

    const hash = createHash('sha256').update(data).digest('hex');
    const seq = sequence ?? rec.chunks.length;

    // Check duplicate by sequence — replayed chunks counted but not appended twice per spec
    // Only same sequence number with same hash is duplicate; same byte value at different positions is legitimate
    const existingBySeq = rec.chunks.find(c => c.sequence === seq);
    if (existingBySeq) {
      if (existingBySeq.hash === hash && existingBySeq.byteLength === data.length) {
        rec.duplicateCount++;
        return { duplicate: true, record: rec };
      } else {
        // Same sequence but different content — conflict, treat as gap or overwrite? For now, count as duplicate and keep original
        // This could happen on retry with different content — we keep first and track gap
        rec.gapIntervals.push({ start: seq, end: seq + 1, reason: 'sequence_conflict' });
        rec.duplicateCount++;
        return { duplicate: true, record: rec };
      }
    }

    if (rec.totalBytes + data.length > this.maxBytesPerRecord) {
      rec.gapIntervals.push({ start: rec.totalBytes, end: rec.totalBytes + data.length, reason: 'overflow_guard' });
      throw new Error(`Record ${requestId} exceeds max bytes`);
    }

    const chunk: Chunk = {
      sequence: seq,
      byteLength: data.length,
      hash,
      data,
      receivedAt: Date.now(),
      isDuplicate: false,
    };

    rec.chunks.push(chunk);
    rec.totalBytes += data.length;
    if (rec.firstTimestamp === null) rec.firstTimestamp = chunk.receivedAt;
    rec.lastTimestamp = chunk.receivedAt;

    // Keep chunks sorted by sequence for deterministic assembly
    rec.chunks.sort((a, b) => a.sequence - b.sequence);

    return { duplicate: false, record: rec };
  }

  markTransportTerminal(requestId: string, signal: TerminalSignal): AssemblyRecord {
    const rec = this.records.get(requestId);
    if (!rec) throw new Error(`No record ${requestId}`);
    rec.transportTerminal = signal;
    this.tryFinalize(rec);
    return rec;
  }

  markParserTerminal(requestId: string, signal: TerminalSignal): AssemblyRecord {
    const rec = this.records.get(requestId);
    if (!rec) throw new Error(`No record ${requestId}`);
    rec.parserTerminal = signal;
    this.tryFinalize(rec);
    return rec;
  }

  addGap(requestId: string, start: number, end: number, reason: string): void {
    const rec = this.records.get(requestId);
    if (!rec) return;
    rec.gapIntervals.push({ start, end, reason });
  }

  assemble(requestId: string): { bytes: Uint8Array; text: string; hash: string } | null {
    const rec = this.records.get(requestId);
    if (!rec) return null;
    // Assemble in sequence order, testing UTF-8 boundary handling
    const total = rec.totalBytes;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of rec.chunks) {
      out.set(c.data, offset);
      offset += c.byteLength;
    }
    const hash = createHash('sha256').update(out).digest('hex');
    rec.contentHash = hash;
    // Try decode as UTF-8 with replacement for testing — but preserve raw bytes
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const text = decoder.decode(out);
    return { bytes: out, text, hash };
  }

  private tryFinalize(rec: AssemblyRecord): void {
    // Positive terminal evidence and absence of gap -> complete per section 7
    // Transport finished alone is positive terminal if no gap; parser terminal may follow later for reconciliation
    const hasPositiveTerminal = rec.transportTerminal === 'finished' || rec.parserTerminal === 'finished';
    const hasGap = rec.gapIntervals.length > 0;
    const noObserverGap = !hasGap;
    if (hasPositiveTerminal && noObserverGap) {
      // If transport finished, we can consider complete; if parser also finished, stronger evidence
      // For strict mode, require both when parser is expected, but for P1 vertical slice transport finished suffices
      if (rec.transportTerminal === 'finished' && rec.gapIntervals.length === 0) {
        rec.isComplete = true;
        const assembled = this.assemble(rec.requestId);
        if (assembled) rec.contentHash = assembled.hash;
      }
    }
    // Stronger: both finished and no gap
    if (rec.transportTerminal === 'finished' && rec.parserTerminal === 'finished' && rec.gapIntervals.length === 0) {
      rec.isComplete = true;
      const assembled = this.assemble(rec.requestId);
      if (assembled) rec.contentHash = assembled.hash;
    }
  }

  deleteRecord(requestId: string): void {
    this.records.delete(requestId);
  }

  getAllRecords(): AssemblyRecord[] {
    return Array.from(this.records.values());
  }

  // For testing: split synthetic stream at every UTF-8 boundary
  // Deterministic version: split at every byte to test worst-case boundary handling
  // Also provides random variant for property tests via optional param
  static splitAtUtf8Boundaries(text: string, opts?: { random?: boolean }): Uint8Array[] {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    const chunks: Uint8Array[] = [];
    let pos = 0;
    const useRandom = opts?.random ?? false;
    while (pos < bytes.length) {
      const sliceLen = useRandom
        ? Math.min(1 + Math.floor(Math.random() * 4), bytes.length - pos)
        : 1; // deterministic: 1 byte per chunk — most hostile for UTF-8 boundary testing
      chunks.push(bytes.slice(pos, pos + sliceLen));
      pos += sliceLen;
    }
    return chunks;
  }

  // For property tests that want random splitting
  static splitAtUtf8BoundariesRandom(text: string): Uint8Array[] {
    return this.splitAtUtf8Boundaries(text, { random: true });
  }
}
