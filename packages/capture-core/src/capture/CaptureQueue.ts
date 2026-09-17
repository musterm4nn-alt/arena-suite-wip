/**
 * Bounded capture queue per 6.1 attach-before-navigate
 * Prevents unbounded memory growth under pressure (P6)
 */

export interface QueuedItem<T> {
  id: string;
  accountId: string;
  payload: T;
  enqueuedAt: number;
  sizeBytes: number;
}

export class CaptureQueue<T> {
  private queue: QueuedItem<T>[] = [];
  private totalBytes = 0;
  private droppedCount = 0;
  private highWaterMark = 0;

  constructor(
    private maxItems = 10000,
    private maxBytes = 100 * 1024 * 1024, // 100MB
  ) {}

  enqueue(item: QueuedItem<T>): { accepted: boolean; reason?: string } {
    if (this.queue.length >= this.maxItems) {
      this.droppedCount++;
      return { accepted: false, reason: 'queue_full_items' };
    }
    if (this.totalBytes + item.sizeBytes > this.maxBytes) {
      this.droppedCount++;
      return { accepted: false, reason: 'queue_full_bytes' };
    }
    this.queue.push(item);
    this.totalBytes += item.sizeBytes;
    this.highWaterMark = Math.max(this.highWaterMark, this.queue.length);
    return { accepted: true };
  }

  dequeue(): QueuedItem<T> | undefined {
    const item = this.queue.shift();
    if (item) {
      this.totalBytes -= item.sizeBytes;
    }
    return item;
  }

  peek(): QueuedItem<T> | undefined {
    return this.queue[0];
  }

  size(): number {
    return this.queue.length;
  }

  bytes(): number {
    return this.totalBytes;
  }

  getHighWaterMark(): number {
    return this.highWaterMark;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  drain(): QueuedItem<T>[] {
    const items = this.queue.splice(0);
    this.totalBytes = 0;
    return items;
  }

  // For P6 measurement
  getStats() {
    return {
      size: this.size(),
      bytes: this.bytes(),
      highWaterMark: this.highWaterMark,
      droppedCount: this.droppedCount,
      maxItems: this.maxItems,
      maxBytes: this.maxBytes,
    };
  }
}
