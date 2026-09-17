import type { RoutedEvent, RoutedEventInput } from '@arena/schema';

/**
 * Bounded capture queue (plan §6.2/§16): overflow must become an explicit
 * `observer_gap`, never silent loss. High-water marks are measured facts for
 * the P6 quota work.
 */
export interface QueueMetrics {
  enqueued: number;
  dropped: number;           // events dropped due to backpressure policy
  overflowEvents: number;    // number of gap-inducing overflows
  highWater: number;         // max observed depth
  slowestDrainMs: number;
}

export type QueuePolicy = 'block_capture' | 'drop_and_mark_gap';

export class CaptureQueue {
  #items: RoutedEvent[] = [];
  #cap: number;
  #policy: QueuePolicy;
  #m: QueueMetrics = { enqueued: 0, dropped: 0, overflowEvents: 0, highWater: 0, slowestDrainMs: 0 };
  #gapListeners = new Set<(info: { lostCount: number; oldestDroppedAt: number }) => void>();

  constructor(cap: number, policy: QueuePolicy = 'drop_and_mark_gap') { this.#cap = cap; this.#policy = policy; }

  push(ev: RoutedEventInput): boolean {
    this.#m.enqueued++;
    if (this.#items.length >= this.#cap) {
      if (this.#policy === 'block_capture') {
        // Blocking the CDP read side is only safe if the adapter supports durable buffering;
        // in sandbox the mock enforces capacity at the supervisor level via onGap.
        this.#onOverflow();
        return false;
      }
      // drop newest non-critical, keep terminals; if even terminals overflow, count everything
      if (ev.kind === 'stream_end' || ev.kind === 'target_info') {
        // never silently drop a terminal: drop a middle item instead
        const dropIdx = this.#items.findIndex((x) => x.kind !== 'stream_end' && x.kind !== 'target_info');
        if (dropIdx >= 0) {
          this.#items.splice(dropIdx, 1);
          this.#m.dropped++;
          this.#onOverflow();
        } else {
          this.#m.dropped++;
          this.#onOverflow();
          return false;
        }
      } else {
        this.#m.dropped++;
        this.#onOverflow();
        return false;
      }
    }
    const stamped: RoutedEvent = { completeness: 'unknown', ...ev } as RoutedEvent;
    this.#items.push(stamped);
    this.#m.highWater = Math.max(this.#m.highWater, this.#items.length);
    return true;
  }

  drain(max = this.#cap): RoutedEvent[] {
    const t0 = Date.now();
    const out = this.#items.splice(0, max);
    this.#m.slowestDrainMs = Math.max(this.#m.slowestDrainMs, Date.now() - t0);
    return out;
  }

  onGap(cb: (info: { lostCount: number; oldestDroppedAt: number }) => void): () => void {
    this.#gapListeners.add(cb);
    return () => this.#gapListeners.delete(cb);
  }

  #oldestSeenAt = 0;
  noteSeenAt(at: number): void { this.#oldestSeenAt = at; }
  #onOverflow(): void {
    this.#m.overflowEvents++;
    for (const cb of this.#gapListeners) cb({ lostCount: this.#m.dropped, oldestDroppedAt: this.#oldestSeenAt });
  }

  get size(): number { return this.#items.length; }
  get metrics(): Readonly<QueueMetrics> { return { ...this.#m }; }
}
