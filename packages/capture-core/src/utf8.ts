/**
 * Incremental UTF-8 decoding that never corrupts split multi-byte boundaries
 * (plan §6.3: "UTF-8 and logical record boundaries are tested under arbitrary
 * chunk splitting").
 */
export class Utf8StreamDecoder {
  #pending = new Uint8Array(0);
  #emittedBytes = 0;
  #truncatedAtEnd = false;

  /** Feed a raw chunk; returns the text that is now safe to decode. */
  push(chunk: Uint8Array): string {
    const buf = new Uint8Array(this.#pending.length + chunk.length);
    buf.set(this.#pending, 0);
    buf.set(chunk, this.#pending.length);

    // Find the last boundary at which the prefix is complete UTF-8.
    let end = buf.length;
    let i = buf.length;
    // Walk back at most 3 bytes to see whether a sequence is cut mid-way.
    for (let k = 1; k <= 4 && i - k >= 0; k++) {
      const b = buf[i - k]!;
      if ((b & 0xc0) !== 0x80) {
        const need = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
        if (need > k) {
          end = i - k; // incomplete trailing sequence; hold it back
        }
        break;
      }
    }
    const decodable = buf.subarray(0, end);
    this.#pending = buf.slice(end);
    this.#emittedBytes += decodable.length;
    // non-fatal: lone surrogates are replaced by TextDecoder
    return new TextDecoder('utf-8').decode(decodable);
  }

  /** Call at stream end: pending trailing bytes mean truncated UTF-8. */
  finish(): { tail: string; truncated: boolean } {
    if (this.#pending.length === 0) return { tail: '', truncated: false };
    const tail = new TextDecoder('utf-8').decode(this.#pending); // replacement chars
    const truncated = tail.includes('\uFFFD');
    this.#emittedBytes += this.#pending.length;
    this.#truncatedAtEnd = truncated;
    this.#pending = new Uint8Array(0);
    return { tail, truncated };
  }

  get emittedBytes(): number { return this.#emittedBytes; }
  get pendingBytes(): number { return this.#pending.length; }
  get sawTruncation(): boolean { return this.#truncatedAtEnd; }
}

/**
 * Line-delimited record buffer shared by SSE and NDJSON parsers: feeds of
 * arbitrary chunk boundaries always yield whole logical records.
 */
export class LineBuffer {
  #text = '';
  push(s: string, onLine: (line: string) => void): void {
    this.#text += s;
    let nl: number;
    while ((nl = this.#text.indexOf('\n')) >= 0) {
      const line = this.#text.slice(0, nl);
      this.#text = this.#text.slice(nl + 1);
      onLine(line.replace(/\r$/, ''));
    }
  }
  flush(onLine: (line: string) => void): void {
    if (this.#text.length > 0) {
      onLine(this.#text);
      this.#text = '';
    }
  }
  get hasPending(): boolean { return this.#text.length > 0; }
}
