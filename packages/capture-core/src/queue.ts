/**
 * @arena/capture-core/queue — bounded capture queue (P0 overflow tests).
 *
 * The capture path between CDP and the archive service is bounded: when the
 * queue overflows, the OLDEST unprocessed batch is evicted and an explicit
 * observer-gap marker is emitted. Capture never grows memory without bound and
 * never silently drops.
 */

export interface GapMarker {
  type: "observer-gap";
  droppedBatches: number;
  droppedEvents: number;
  atMs: number;
}

export class BoundedCaptureQueue<T> {
  private readonly items: T[] = [];
  private droppedBatches = 0;
  private droppedEvents = 0;
  private highWater = 0;

  constructor(
    readonly capacity: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("capacity must be a positive integer");
    }
  }

  get size(): number {
    return this.items.length;
  }

  get highWaterMark(): number {
    return this.highWater;
  }

  /** Push a batch; evicts oldest batches first on overflow. Returns gap marker if anything was dropped. */
  push(batch: T, batchEventCount = 1): GapMarker | null {
    let marker: GapMarker | null = null;
    while (this.items.length >= this.capacity) {
      this.items.shift();
      this.droppedBatches += 1;
      this.droppedEvents += batchEventCount;
      marker = {
        type: "observer-gap",
        droppedBatches: this.droppedBatches,
        droppedEvents: this.droppedEvents,
        atMs: this.now(),
      };
    }
    this.items.push(batch);
    if (this.items.length > this.highWater) this.highWater = this.items.length;
    return marker;
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }

  dropStats(): { droppedBatches: number; droppedEvents: number } {
    return { droppedBatches: this.droppedBatches, droppedEvents: this.droppedEvents };
  }
}
