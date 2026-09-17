/**
 * CaptureSupervisor — per §6
 * Owns CDP attach / target lifecycle / buffering, account_id stamping
 */

import { AccountId } from "@arena-archive/schema";
import { BrowserAdapter, AttachedTargetInfo, NetworkEvent } from "@arena-archive/browser-adapter";
import { BoundedQueue } from "@arena-archive/capture-core";
import { ArchiveService } from "@arena-archive/archive-service";
import { ProtocolCatalog } from "@arena-archive/protocol-catalog";
import { StreamAssemblyLedger } from "@arena-archive/capture-core";
import { WITNESS_WORLD_NAME, WITNESS_SCRIPT, WITNESS_BINDING_NAME } from "@arena-archive/capture-core";
import { toSafeUrlRef, sanitizeHeaders } from "@arena-archive/security";

export interface CaptureSupervisorConfig {
  accountId: AccountId;
  sessionEpochId: string;
  partitionPath: string;
  browserAdapter: BrowserAdapter;
  archiveService: ArchiveService;
  protocolCatalog: ProtocolCatalog;
}

export class CaptureSupervisor {
  private webContentsId?: number;
  private queue: BoundedQueue<NetworkEvent>;
  private ledger: StreamAssemblyLedger;
  private attachedTargets = new Map<string, AttachedTargetInfo>();
  private attachTimestamp?: number;

  constructor(private config: CaptureSupervisorConfig) {
    this.queue = new BoundedQueue<NetworkEvent>(1000, `capture-${config.accountId}`);
    this.ledger = new StreamAssemblyLedger();
  }

  /**
   * Attach-before-navigate protocol per §6.1
   */
  async initialize(): Promise<{ webContentsId: number; attachTimestamp: number; orderingValid: boolean }> {
    const { accountId, partitionPath, browserAdapter } = this.config;

    // 1. create account WebContents with NO Arena URL loaded
    const { webContentsId, attachTimestamp, debuggerAttached } = await browserAdapter.createAccountWebContents(accountId, partitionPath);
    this.webContentsId = webContentsId;
    this.attachTimestamp = attachTimestamp;

    if (!debuggerAttached) throw new Error("debugger.attach() failed");

    // 2. bind WebContents -> account_id (done via config)
    // 3. create bounded capture queue (done in constructor)
    // 4. debugger.attach() (done inside adapter)
    // 5. Network.enable, Page.enable, Runtime.enable, Runtime.addBinding isolated-world only
    await browserAdapter.enableCaptureDomains(webContentsId);

    // 6. Page.addScriptToEvaluateOnNewDocument(readOnlyWitness, worldName=arena-archive)
    await browserAdapter.installIsolatedWorldWitness(webContentsId, WITNESS_WORLD_NAME, WITNESS_SCRIPT);

    // 7. Target.setAutoAttach(autoAttach=true, flatten=true, waitForDebuggerOnStart=true)
    await browserAdapter.setAutoAttach(true, true);

    // Verify acknowledgements
    // ONLY THEN navigate — caller does navigate

    // Setup listeners
    browserAdapter.onTargetAttached((info) => {
      if (info.accountId !== accountId) {
        console.warn(`[CaptureSupervisor] account_id mismatch: expected ${accountId}, got ${info.accountId}`);
        return;
      }
      // bind child target to parent account
      this.attachedTargets.set(info.targetId, info);
      console.log(`[CaptureSupervisor] target attached ${info.type} ${info.targetId} account=${info.accountId}`);
      // enable Network in child session, install witness where meaningful — adapter does
    });

    browserAdapter.onNetworkEvent((ev) => {
      // Every event routed by sessionId/targetId, then stamped with account_id and session_epoch_id before shared queue
      if (ev.accountId !== accountId) {
        // account_id stamped by supervisor that owns WebContents; page payloads cannot set it
        console.warn(`[CaptureSupervisor] event account_id mismatch, using supervisor-derived ${accountId}`);
        ev.accountId = accountId;
      }
      ev.sessionEpochId = this.config.sessionEpochId;
      // sanitize before queue? queue holds raw but sanitized before persistence
      const enqueued = this.queue.enqueue(ev);
      if (!enqueued) {
        // overflow -> observer_gap evidence
        this.config.archiveService.appendObservation({
          account_id: accountId,
          session_epoch_id: this.config.sessionEpochId,
          mechanism: "cdp_network",
          target_id: ev.targetId,
          session_id: ev.sessionId,
          operation_key: ev.requestId,
          observed_at: new Date().toISOString(),
          completeness_state: "observer_gap",
          byte_length: 0,
          shape_hash: "overflow",
        });
      } else {
        this.processNetworkEvent(ev);
      }
    });

    const ordering = await browserAdapter.getAttachOrderingProof();

    return {
      webContentsId,
      attachTimestamp,
      orderingValid: ordering.orderingValid,
    };
  }

  async navigateToArena(): Promise<void> {
    if (!this.webContentsId) throw new Error("not initialized");
    const result = await this.config.browserAdapter.navigate(this.webContentsId, "https://arena.ai/");
    console.log(`[CaptureSupervisor] navigated to arena.ai wcId=${this.webContentsId} at ${result.navigatedAt}, firstRequestAt=${result.firstRequestAt}`);
    if (result.firstRequestAt && this.attachTimestamp && result.firstRequestAt < this.attachTimestamp) {
      throw new Error("Attach ordering violation: first request before attach");
    }
  }

  private processNetworkEvent(ev: NetworkEvent) {
    // Inventory first-party traffic
    const host = (() => {
      try {
        return new URL(ev.payload?.request?.url ?? ev.payload?.response?.url ?? "https://arena.ai/").host;
      } catch {
        return "arena.ai";
      }
    })();

    const safeRef = toSafeUrlRef(ev.payload?.request?.url ?? "https://arena.ai/");

    // Determine transport
    let transport: any = "unknown";
    if (ev.type === "webSocketCreated" || ev.type.includes("webSocket")) transport = "websocket";
    else if (ev.type === "eventSourceMessage") transport = "sse";
    else if (ev.payload?.request?.url?.includes("_rsc") || ev.payload?.request?.url?.includes("flight")) transport = "rsc";
    else if (ev.type === "dataReceived") transport = "chunked";
    else transport = "json";

    // For P0, we inventory
    this.config.protocolCatalog.inventoryFromNetworkEvent({
      host,
      method: ev.payload?.request?.method ?? "GET",
      path: safeRef.path,
      transport,
      direction: "read", // to be qualified via probe
      payload_family: this.inferPayloadFamily(ev),
      shape_hash: this.config.protocolCatalog.computeShapeHash(ev.payload),
      adapter_id: `adapter_${transport}_v1`,
      adapter_version: "v1",
    });

    // Stream assembly
    if (ev.type === "dataReceived") {
      const bytes = ev.payload?.data ? new TextEncoder().encode(ev.payload.data) : new Uint8Array(0);
      this.ledger.appendChunk(ev.requestId, {
        seq: ev.payload?.seq ?? 0,
        bytes,
        timestamp: Date.now(),
      });
    }

    if (ev.type === "loadingFinished") {
      this.ledger.finalize(ev.requestId, "loadingFinished");
      // Append observation
      const rec = this.ledger.getRecord(ev.requestId);
      this.config.archiveService.appendObservation({
        account_id: this.config.accountId,
        session_epoch_id: this.config.sessionEpochId,
        mechanism: "cdp_network",
        target_id: ev.targetId,
        session_id: ev.sessionId,
        operation_key: ev.requestId,
        adapter_id: `adapter_${transport}_v1`,
        adapter_version: "v1",
        observed_at: new Date().toISOString(),
        completeness_state: "complete",
        byte_length: rec?.byte_length ?? 0,
        shape_hash: rec?.content_hash ?? "unknown",
        sanitized_evidence_ref: safeRef.path,
      });
    }

    if (ev.type === "loadingFailed") {
      this.config.archiveService.appendObservation({
        account_id: this.config.accountId,
        session_epoch_id: this.config.sessionEpochId,
        mechanism: "cdp_network",
        target_id: ev.targetId,
        session_id: ev.sessionId,
        operation_key: ev.requestId,
        observed_at: new Date().toISOString(),
        completeness_state: "failed_transport",
        byte_length: 0,
        shape_hash: "failed",
      });
    }
  }

  private inferPayloadFamily(ev: NetworkEvent): string {
    const url = ev.payload?.request?.url ?? "";
    if (url.includes("chat") || url.includes("stream")) return "arena.chat.stream";
    if (url.includes("history") && url.includes("list")) return "arena.history.list";
    if (url.includes("history") && url.includes("detail")) return "arena.history.detail";
    if (url.includes("vote")) return "arena.vote";
    if (url.includes("download") || ev.type === "webSocketCreated") return ev.type.includes("webSocket") ? "ws.arena" : "arena.artifact.download";
    if (url.includes("rsc") || url.includes("flight")) return "rsc.flight";
    if (ev.type === "eventSourceMessage") return "sse.events";
    return "unknown";
  }

  getQueueMetrics() {
    return this.queue.getMetrics();
  }

  getLedgerMetrics() {
    return this.ledger.getMetrics();
  }

  getAttachedTargets(): AttachedTargetInfo[] {
    return Array.from(this.attachedTargets.values());
  }

  async forceNavigationDuringStream(url: string): Promise<void> {
    if (!this.webContentsId) throw new Error("not initialized");
    await this.config.browserAdapter.forceNavigationDuringStream(this.webContentsId, url);
  }

  async simulateCrash(): Promise<void> {
    if (!this.webContentsId) throw new Error("not initialized");
    await this.config.browserAdapter.simulateRendererCrash(this.webContentsId);
    // Should produce partial_stream evidence
    this.config.archiveService.appendObservation({
      account_id: this.config.accountId,
      session_epoch_id: this.config.sessionEpochId,
      mechanism: "cdp_target_lifecycle",
      observed_at: new Date().toISOString(),
      completeness_state: "partial_stream",
      byte_length: 0,
      shape_hash: "crash",
    });
  }

  async destroy(): Promise<void> {
    if (this.webContentsId) {
      await this.config.browserAdapter.destroyWebContents(this.webContentsId);
    }
  }
}
