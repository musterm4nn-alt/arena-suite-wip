/**
 * CaptureSupervisor — CDP attach / target lifecycle / buffering (plan §6).
 *
 * Owns the WebContents -> account binding and stamps account_id + epoch on
 * every event BEFORE it enters any shared queue (CaptureRouter). Runs in the
 * Electron main process; the archive service consumes via typed IPC.
 */
import { CaptureRouter, BoundedCaptureQueue, type RoutedEvent } from "@arena/capture-core";
import type { CdpEvent } from "@arena/browser-adapter";

export interface SupervisorOptions {
  accountId: string;
  epochId: string | null;
  queueCapacity?: number;
}

export class CaptureSupervisor {
  readonly accountId: string;
  private epochId: string | null;
  private readonly router = new CaptureRouter();
  private readonly queue: BoundedCaptureQueue<RoutedEvent>;
  private droppedUnbound = 0;

  constructor(opts: SupervisorOptions) {
    this.accountId = opts.accountId;
    this.epochId = opts.epochId;
    this.queue = new BoundedCaptureQueue<RoutedEvent>(opts.queueCapacity ?? 4096);
  }

  setEpoch(epochId: string | null): void {
    this.epochId = epochId;
    // Rebind known sessions to the new epoch is handled by bindSession calls
    // from the adapter layer after epoch rollover.
  }

  bindSession(cdpSessionId: string): void {
    this.router.bindSession(cdpSessionId, { accountId: this.accountId, epochId: this.epochId });
  }

  bindTarget(targetId: string): void {
    this.router.bindTarget(targetId, { accountId: this.accountId, epochId: this.epochId });
  }

  unbindSession(cdpSessionId: string): void {
    this.router.unbindSession(cdpSessionId);
  }

  /** Ingest one raw CDP event; returns the gap marker when the queue overflowed. */
  ingest(evt: CdpEvent): { gap: boolean } {
    const routed = this.router.route({
      method: evt.method,
      params: evt.params,
      cdpSessionId: evt.cdpSessionId ?? null,
      targetId: evt.targetId ?? null,
    });
    if (!routed) {
      this.droppedUnbound += 1;
      return { gap: false };
    }
    const marker = this.queue.push(routed);
    return { gap: marker !== null };
  }

  drain(): RoutedEvent[] {
    return this.queue.drain();
  }

  stats(): { queued: number; highWater: number; droppedUnbound: number; dropped: { droppedBatches: number; droppedEvents: number } } {
    return {
      queued: this.queue.size,
      highWater: this.queue.highWaterMark,
      droppedUnbound: this.droppedUnbound,
      dropped: this.queue.dropStats(),
    };
  }
}
