import { LineBuffer } from './utf8.ts';
import { sha256Hex } from '@arena/core';

/**
 * Transport-specific logical-record parsers. SSE and WebSocket frames are
 * captured "independently; never force all transports through one parser" (§6.2).
 */

export interface SseRecord {
  event: string;          // defaults to "message"
  data: string;
  id: string | null;
  retry: number | null;
  isDone: boolean;        // `data: [DONE]` terminal marker
}

/** Streaming EventSource parser: feeds arbitrary chunk boundaries, emits whole records. */
export class SseParser {
  #buf = new LineBuffer();
  #onRecord: (r: SseRecord) => void;
  #fields: { event?: string; data: string[]; id?: string | null; retry?: number | null } = { data: [] };
  #lastEventId: string | null = null;

  constructor(onRecord: (r: SseRecord) => void) { this.#onRecord = onRecord; }

  push(text: string): void {
    this.#buf.push(text, (line) => this.#onLine(line));
  }

  finish(): { cleanClose: boolean } {
    let clean = true;
    // A dangling record (no blank line) or pending half-line means the stream
    // ended without a valid terminal → caller must mark partial_stream.
    if (this.#buf.hasPending || this.#fields.data.length > 0 || this.#fields.event !== undefined) clean = false;
    this.#buf.flush((line) => { this.#onLine(line); this.#emit(true); });
    return { cleanClose: clean };
  }

  #onLine(line: string): void {
    if (line === '') { this.#emit(); return; }
    if (line.startsWith(':')) return; // comment
    const idx = line.indexOf(':');
    const field = idx < 0 ? line : line.slice(0, idx);
    let value = idx < 0 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': this.#fields.event = value; break;
      case 'data': this.#fields.data.push(value); break;
      case 'id': this.#fields.id = value; break;
      case 'retry': { const n = Number(value); if (Number.isFinite(n)) this.#fields.retry = n; break; }
      default: break; // unknown fields ignored per spec
    }
  }

  #emit(fromFlush = false): void {
    const f = this.#fields;
    this.#fields = { data: [] };
    if (f.data.length === 0 && f.event === undefined) return;
    const data = f.data.join('\n');
    if (f.id !== undefined && f.id !== null) this.#lastEventId = f.id;
    this.#onRecord({
      event: f.event ?? 'message',
      data,
      id: f.id ?? this.#lastEventId,
      retry: f.retry ?? null,
      isDone: data === '[DONE]',
    });
    void fromFlush;
  }
}

/** NDJSON / streamed-JSON-lines parser with terminal `[DONE]` support. */
export class NdjsonParser {
  #buf = new LineBuffer();
  #onRecord: (rec: { ok: true; value: unknown } | { ok: false; line: string; byteLength: number }) => void;
  #parsed = 0;
  #parseErrors = 0;
  #sawDone = false;
  constructor(onRecord: (rec: { ok: true; value: unknown } | { ok: false; line: string; byteLength: number }) => void) { this.#onRecord = onRecord; }

  pushText(text: string): void {
    this.#buf.push(text, (line) => this.#onLine(line));
  }

  pushBytes(bytes: Uint8Array, decoder: { push(b: Uint8Array): string }): void {
    this.pushText(decoder.push(bytes));
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    if (trimmed === '[DONE]') { this.#sawDone = true; this.#onRecord({ ok: false, line: '[DONE]', byteLength: 6 }); return; }
    try {
      const value = JSON.parse(trimmed);
      this.#parsed++;
      this.#onRecord({ ok: true, value });
    } catch {
      // Parser failures NEVER trigger raw dumps (§8): only length reported to caller.
      this.#parseErrors++;
      this.#onRecord({ ok: false, line: '<unparseable>', byteLength: Buffer.byteLength(trimmed) });
    }
  }

  finish(): { parsed: number; parseErrors: number; sawDone: boolean; pendingBytes: number } {
    if (this.#buf.hasPending) {
      this.#buf.flush((line) => this.#onLine(line));
    }
    return { parsed: this.#parsed, parseErrors: this.#parseErrors, sawDone: this.#sawDone, pendingBytes: this.#buf.hasPending ? 1 : 0 };
  }
}

/**
 * WebSocket frames arrive already decoded by CDP (Network.webSocketFrameReceived
 * carries payloadData). We keep a per-connection record ledger with duplicate
 * detection keyed on event id when present.
 */
export interface WsFrameInput { at: number; payload: string; eventId?: string | null; isText: boolean }
export class WsLedger {
  #seen = new Set<string>();
  frames = 0;
  duplicates = 0;
  binaryFrames = 0;
  bytes = 0;
  #hasherParts: string[] = [];
  #closed = false;
  #errorClosed = false;

  note(f: WsFrameInput): void {
    this.#closed = false;
    const key = f.eventId ?? `${this.frames}:${sha256Hex(f.payload).slice(0, 16)}`;
    if (this.#seen.has(key)) { this.duplicates++; return; }
    this.#seen.add(key);
    this.frames++;
    if (!f.isText) { this.binaryFrames++; this.bytes += Buffer.byteLength(f.payload, 'latin1'); return; }
    this.bytes += Buffer.byteLength(f.payload, 'utf8');
    this.#hasherParts.push(f.payload);
  }

  markClosed(): void { this.#closed = true; }
  markError(): void { this.#errorClosed = true; }

  summary(): { frames: number; duplicates: number; binaryFrames: number; bytes: number; closed: boolean; errorClosed: boolean; payloadSha256: string } {
    return {
      frames: this.frames, duplicates: this.duplicates, binaryFrames: this.binaryFrames,
      bytes: this.bytes, closed: this.#closed, errorClosed: this.#errorClosed,
      payloadSha256: sha256Hex(this.#hasherParts.join("")),
    };
  }
}

