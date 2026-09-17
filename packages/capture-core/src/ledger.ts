/**
 * @arena/capture-core/ledger — per-request stream assembly ledger (plan §6.3).
 *
 * Operates on BYTES, never on JS strings, so arbitrary chunk splits (including
 * mid-UTF-8-sequence and mid-record splits) are handled by construction.
 * Duplicate deliveries are counted, never appended twice. Gap intervals are
 * first-class: a turn with an unresolved gap can never become `complete`.
 */
import { createHash } from "node:crypto";
import type { TerminalSignal } from "@arena/schema";

export interface ChunkAppend {
  /** Monotonic chunk sequence within this logical stream. */
  seq: number;
  bytes: Uint8Array;
  receivedAtMs: number;
}

export interface GapInterval {
  fromSeq: number;
  toSeq: number;
  reason: "missing" | "evicted" | "target-lost";
}

export interface LedgerSnapshot {
  streamId: string;
  chunksAccepted: number;
  bytesAccepted: number;
  contentHash: string | null;
  duplicateCount: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
  expectedContentLength: number | null;
  transportTerminal: TerminalSignal | null;
  parserTerminal: boolean;
  gaps: GapInterval[];
  evicted: boolean;
}

const MAX_GAP_INTERVALS = 512;

export class AssemblyLedger {
  readonly streamId: string;
  readonly accountId: string;
  readonly targetId: string | null;
  readonly cdpSessionId: string | null;

  private readonly seenSeq = new Set<number>();
  private readonly buffers: Array<{ seq: number; bytes: Uint8Array }> = [];
  private bytesAccepted = 0;
  private duplicateCount = 0;
  private firstAtMs: number | null = null;
  private lastAtMs: number | null = null;
  private expectedContentLength: number | null = null;
  private transportTerminal: TerminalSignal | null = null;
  private parserTerminal = false;
  private readonly gaps: GapInterval[] = [];
  private evicted = false;

  constructor(opts: {
    streamId: string;
    accountId: string;
    targetId?: string | null;
    cdpSessionId?: string | null;
    expectedContentLength?: number | null;
  }) {
    this.streamId = opts.streamId;
    this.accountId = opts.accountId;
    this.targetId = opts.targetId ?? null;
    this.cdpSessionId = opts.cdpSessionId ?? null;
    this.expectedContentLength = opts.expectedContentLength ?? null;
  }

  /** Append one chunk. Returns "accepted" | "duplicate". Never throws on data. */
  append(chunk: ChunkAppend): "accepted" | "duplicate" {
    if (this.seenSeq.has(chunk.seq)) {
      this.duplicateCount += 1;
      return "duplicate";
    }
    this.seenSeq.add(chunk.seq);
    // Copy defensively: callers reuse CDP buffers.
    this.buffers.push({ seq: chunk.seq, bytes: Uint8Array.from(chunk.bytes) });
    this.bytesAccepted += chunk.bytes.byteLength;
    if (this.firstAtMs === null || chunk.receivedAtMs < this.firstAtMs) {
      this.firstAtMs = chunk.receivedAtMs;
    }
    if (this.lastAtMs === null || chunk.receivedAtMs > this.lastAtMs) {
      this.lastAtMs = chunk.receivedAtMs;
    }
    return "accepted";
  }

  /** Record a known-missing sequence interval (observer absence, eviction...). */
  recordGap(gap: GapInterval): void {
    if (this.gaps.length >= MAX_GAP_INTERVALS) return;
    this.gaps.push(gap);
    if (gap.reason === "evicted") this.evicted = true;
  }

  markEvicted(): void {
    this.evicted = true;
  }

  markTransportTerminal(signal: TerminalSignal): void {
    this.transportTerminal = signal;
  }

  markParserTerminal(): void {
    this.parserTerminal = true;
  }

  setExpectedContentLength(n: number | null): void {
    this.expectedContentLength = n;
  }

  /** True when no unresolved observer gap exists at the ending. */
  hasUnresolvedGap(): boolean {
    if (this.evicted || this.gaps.length > 0) return true;
    if (this.seenSeq.size === 0) return false;
    // Detect implicit gaps in the accepted sequence space.
    const sorted = [...this.seenSeq].sort((a, b) => a - b);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (first === undefined || last === undefined) return false;
    return last - first + 1 !== sorted.length;
  }

  /** Assembled bytes in sequence order. Gaps are NOT filled — callers must check hasUnresolvedGap(). */
  assembledBytes(): Uint8Array {
    const sorted = [...this.buffers].sort((a, b) => a.seq - b.seq);
    const out = new Uint8Array(this.bytesAccepted);
    let off = 0;
    for (const b of sorted) {
      out.set(b.bytes, off);
      off += b.bytes.byteLength;
    }
    return out;
  }

  contentHash(): string | null {
    if (this.buffers.length === 0) return null;
    return createHash("sha256").update(this.assembledBytes()).digest("hex");
  }

  snapshot(): LedgerSnapshot {
    return {
      streamId: this.streamId,
      chunksAccepted: this.seenSeq.size,
      bytesAccepted: this.bytesAccepted,
      contentHash: this.contentHash(),
      duplicateCount: this.duplicateCount,
      firstAtMs: this.firstAtMs,
      lastAtMs: this.lastAtMs,
      expectedContentLength: this.expectedContentLength,
      transportTerminal: this.transportTerminal,
      parserTerminal: this.parserTerminal,
      gaps: [...this.gaps],
      evicted: this.evicted,
    };
  }
}
