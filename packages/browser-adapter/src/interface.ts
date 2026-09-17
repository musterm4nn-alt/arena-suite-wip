/**
 * BrowserAdapter interface — per §17, browser-adapter replaceability is intentional.
 * Electron is primary, CEF is fallback escalation if falsification gates prove insufficient.
 */

export type TargetType = "page" | "iframe" | "dedicated_worker" | "shared_worker" | "service_worker" | "worker" | "other";

export interface AttachedTargetInfo {
  targetId: string;
  sessionId: string;
  type: TargetType;
  url: string;
  parentSessionId?: string;
  accountId: string;
  attachedAt: string; // ISO
}

export interface NetworkEvent {
  requestId: string;
  targetId: string;
  sessionId: string;
  accountId: string;
  sessionEpochId: string;
  timestamp: number;
  type: "requestWillBeSent" | "responseReceived" | "dataReceived" | "loadingFinished" | "loadingFailed" | "webSocketCreated" | "webSocketFrameReceived" | "webSocketFrameSent" | "webSocketHandshake" | "eventSourceMessage";
  payload: any;
  safeUrlRef?: any;
}

export interface StreamChunk {
  requestId: string;
  seq: number;
  bytes: Uint8Array;
  timestamp: number;
  isLast?: boolean;
  duplicate?: boolean;
}

export interface BrowserAdapter {
  readonly name: string;
  readonly version: string;
  readonly capabilities: {
    canObserveServiceWorker: boolean;
    canObserveSharedWorker: boolean;
    canObserveDedicatedWorker: boolean;
    canObserveIframe: boolean;
    canStreamBodies: boolean;
    canObserveWebSocket: boolean;
    canObserveEventSource: boolean;
    supportsFlattenedAutoAttach: boolean;
  };

  /**
   * Attach-before-navigate protocol per §6.1
   * Must assert attach/domain-enable occurs before first navigation request.
   */
  createAccountWebContents(accountId: string, partitionPath: string): Promise<{
    webContentsId: number;
    sessionPartition: string;
    attachTimestamp: number;
    debuggerAttached: boolean;
  }>;

  enableCaptureDomains(webContentsId: number): Promise<void>;

  installIsolatedWorldWitness(webContentsId: number, worldName: string, script: string): Promise<void>;

  setAutoAttach(flatten: boolean, waitForDebuggerOnStart: boolean): Promise<void>;

  onTargetAttached(callback: (info: AttachedTargetInfo) => void): void;
  onTargetDetached(callback: (targetId: string) => void): void;
  onNetworkEvent(callback: (ev: NetworkEvent) => void): void;

  navigate(webContentsId: number, url: string): Promise<{ navigatedAt: number; firstRequestAt?: number }>;

  // For P0: force navigation and renderer process loss during streams
  forceNavigationDuringStream(webContentsId: number, url: string): Promise<void>;
  simulateRendererCrash(webContentsId: number): Promise<void>;

  // Download
  onDownloadStarted(callback: (info: { accountId: string; url: string; filename: string }) => void): void;

  // Cleanup
  destroyWebContents(webContentsId: number): Promise<void>;

  // Diagnostic
  getTargetMatrix(): Promise<Record<TargetType, boolean>>;
  getAttachOrderingProof(): Promise<{ attachTimestamp: number; firstRequestTimestamp?: number; orderingValid: boolean }>;
}

export interface BrowserAdapterFactory {
  create(): Promise<BrowserAdapter>;
}
