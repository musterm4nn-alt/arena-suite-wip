/**
 * Bounded capture queue per §6.1 — explicit overflow handling for P0 hostile test
 */

export interface QueueMetrics {
  enqueued: number;
  dequeued: number;
  dropped: number;
  highWaterMark: number;
  currentSize: number;
}

export class BoundedQueue<T> {
  private queue: T[] = [];
  private metrics: QueueMetrics = {
    enqueued: 0,
    dequeued: 0,
    dropped: 0,
    highWaterMark: 0,
    currentSize: 0,
  };

  constructor(private readonly maxSize: number, private readonly name: string) {}

  enqueue(item: T): boolean {
    if (this.queue.length >= this.maxSize) {
      this.metrics.dropped++;
      // In production: emit observer_gap evidence
      console.warn(`[BoundedQueue:${this.name}] overflow, dropping item, total dropped=${this.metrics.dropped}`);
      return false;
    }
    this.queue.push(item);
    this.metrics.enqueued++;
    this.metrics.currentSize = this.queue.length;
    if (this.queue.length > this.metrics.highWaterMark) {
      this.metrics.highWaterMark = this.queue.length;
    }
    return true;
  }

  dequeue(): T | undefined {
    const item = this.queue.shift();
    if (item) {
      this.metrics.dequeued++;
      this.metrics.currentSize = this.queue.length;
    }
    return item;
  }

  drain(): T[] {
    const items = [...this.queue];
    this.queue = [];
    this.metrics.dequeued += items.length;
    this.metrics.currentSize = 0;
    return items;
  }

  size(): number {
    return this.queue.length;
  }

  getMetrics(): QueueMetrics {
    return { ...this.metrics };
  }

  // For P0: deliberately overflow
  overflowTest(count: number, factory: (i: number) => T): { enqueued: number; dropped: number } {
    let enq = 0;
    let drop = 0;
    for (let i = 0; i < count; i++) {
      if (this.enqueue(factory(i))) enq++;
      else drop++;
    }
    return { enqueued: enq, dropped: drop };
  }
}
