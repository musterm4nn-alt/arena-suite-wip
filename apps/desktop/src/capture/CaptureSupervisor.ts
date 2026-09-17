import { EventRouter, type CdpEvent, type RoutedEvent } from '@arena/capture-core';
import { CaptureQueue } from '@arena/capture-core';
import { StreamAssemblyLedger } from '@arena/capture-core';
import { SessionManager } from '../sessions/SessionManager.js';

/**
 * CaptureSupervisor — owns CDP attachment, target lifecycle, buffering (section 4)
 * Passive observation first — production capture must not alter Arena's networking semantics
 */

export interface CaptureSupervisorConfig {
  maxQueueItems?: number;
  maxQueueBytes?: number;
}

export class CaptureSupervisor {
  private router: EventRouter;
  private queue: CaptureQueue<RoutedEvent>;
  private ledger: StreamAssemblyLedger;
  private sessionManager: SessionManager;
  private attached = new Set<string>(); // accountIds with debugger attached
  private targetToAccount = new Map<string, string>(); // targetId -> accountId
  private sessionIdToAccount = new Map<string, string>(); // CDP sessionId -> accountId

  constructor(sessionManager: SessionManager, config?: CaptureSupervisorConfig) {
    this.sessionManager = sessionManager;
    this.queue = new CaptureQueue<RoutedEvent>(config?.maxQueueItems ?? 10000, config?.maxQueueBytes ?? 100 * 1024 * 1024);
    this.ledger = new StreamAssemblyLedger();

    this.router = new EventRouter((sessionId, targetId) => {
      if (sessionId && this.sessionIdToAccount.has(sessionId)) {
        const accountId = this.sessionIdToAccount.get(sessionId)!;
        const sess = this.sessionManager.getSession(accountId);
        return sess ? { accountId, sessionEpochId: sess.sessionEpochId } : null;
      }
      if (targetId && this.targetToAccount.has(targetId)) {
        const accountId = this.targetToAccount.get(targetId)!;
        const sess = this.sessionManager.getSession(accountId);
        return sess ? { accountId, sessionEpochId: sess.sessionEpochId } : null;
      }
      return null;
    });
  }

  /**
   * Attach-before-navigate protocol per 6.1
   * Must be called before first Arena navigation
   */
  async attach(accountId: string): Promise<void> {
    const session = this.sessionManager.getSession(accountId);
    if (!session) throw new Error(`No session for account ${accountId}`);

    // Simulate Electron debugger steps
    // Real:
    // debugger.attach()
    // Network.enable(explicit buffers; durable messages if supported)
    // Page.enable(), Runtime.enable(), Runtime.addBinding(...)
    // Page.addScriptToEvaluateOnNewDocument(...)
    // Target.setAutoAttach(autoAttach=true, flatten=true, waitForDebuggerOnStart=true)
    // verify acknowledgements

    this.attached.add(accountId);
    console.log(`[CaptureSupervisor] Attached debugger for account=${accountId} epoch=${session.sessionEpochId}`);
  }

  bindTarget(targetId: string, accountId: string, sessionId?: string): void {
    // Capture authority: account_id stamped by CaptureSupervisor that owns WebContents; page payloads cannot set it
    this.targetToAccount.set(targetId, accountId);
    if (sessionId) {
      this.sessionIdToAccount.set(sessionId, accountId);
    }
    console.log(`[CaptureSupervisor] Bound target=${targetId} session=${sessionId ?? 'none'} -> account=${accountId}`);
  }

  handleCdpEvent(event: CdpEvent): void {
    const routed = this.router.route(event);
    if (!routed) {
      // Observer gap — app knows observation was absent
      console.warn(`[CaptureSupervisor] Observer gap: no account binding for target=${event.targetId} session=${event.sessionId} method=${event.method}`);
      return;
    }

    // Route to bounded queue
    const item = {
      id: `${routed.sessionId ?? 'no-session'}-${routed.targetId ?? 'no-target'}-${Date.now()}`,
      accountId: routed.accountId,
      payload: routed,
      enqueuedAt: Date.now(),
      sizeBytes: JSON.stringify(routed).length,
    };
    const result = this.queue.enqueue(item);
    if (!result.accepted) {
      console.warn(`[CaptureSupervisor] Queue rejected: ${result.reason} account=${routed.accountId}`);
      // This creates observer_gap completeness
    }

    // Handle specific events for ledger
    this.handleForLedger(routed);
  }

  private handleForLedger(event: RoutedEvent): void {
    const params = event.params as Record<string, unknown>;
    const requestId = (params.requestId as string) ?? (params.requestId as string);

    switch (event.method) {
      case 'Network.requestWillBeSent': {
        if (!requestId) break;
        if (!this.ledger.getRecord(requestId)) {
          this.ledger.createRecord(requestId, event.accountId, {
            sessionEpochId: event.sessionEpochId,
            targetId: event.targetId ?? null,
            sessionId: event.sessionId ?? null,
            expectedLength: null,
          });
        }
        break;
      }
      case 'Network.dataReceived': {
        if (!requestId) break;
        const data = params.data as string | undefined;
        if (data) {
          try {
            const bytes = Buffer.from(data, 'base64');
            this.ledger.appendChunk(requestId, bytes);
          } catch {}
        }
        break;
      }
      case 'Network.loadingFinished': {
        if (!requestId) break;
        this.ledger.markTransportTerminal(requestId, 'finished');
        break;
      }
      case 'Network.loadingFailed': {
        if (!requestId) break;
        this.ledger.markTransportTerminal(requestId, 'failed');
        break;
      }
    }
  }

  // For diagnostics / P0 spike
  getQueueStats() {
    return this.queue.getStats();
  }

  getLedgerRecords() {
    return this.ledger.getAllRecords();
  }

  isAttached(accountId: string): boolean {
    return this.attached.has(accountId);
  }

  detach(accountId: string): void {
    this.attached.delete(accountId);
    // Clean bindings for this account
    for (const [targetId, acc] of this.targetToAccount) {
      if (acc === accountId) this.targetToAccount.delete(targetId);
    }
    for (const [sessId, acc] of this.sessionIdToAccount) {
      if (acc === accountId) this.sessionIdToAccount.delete(sessId);
    }
  }

  // For P6 measurement
  getStats() {
    return {
      attachedAccounts: Array.from(this.attached),
      targetBindings: this.targetToAccount.size,
      sessionBindings: this.sessionIdToAccount.size,
      queue: this.queue.getStats(),
      ledgerCount: this.ledger.getAllRecords().length,
    };
  }
}
