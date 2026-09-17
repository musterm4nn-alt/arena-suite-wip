/**
 * Browser adapter interface — deliberately browser-adapter-independent core services
 * If hostile spike proves Electron insufficient, replace only this adapter with CEF
 */

export interface BrowserSessionConfig {
  accountId: string;
  partitionPath: string; // app-controlled, never derived from email
  sessionEpochId: string;
}

export interface TargetInfo {
  targetId: string;
  type: 'page' | 'iframe' | 'worker' | 'service_worker' | 'shared_worker' | 'other';
  url: string;
  accountId: string;
}

export interface NetworkEvent {
  requestId: string;
  type: 'requestWillBeSent' | 'responseReceived' | 'dataReceived' | 'loadingFinished' | 'loadingFailed' | 'webSocketFrame' | 'eventSourceMessage';
  targetId: string;
  sessionId: string;
  timestamp: number;
  data: unknown;
}

export interface BrowserAdapter {
  readonly name: 'electron' | 'cef' | 'mock';

  // Session lifecycle — one persistent Session per account
  createSession(config: BrowserSessionConfig): Promise<string>; // returns sessionId
  destroySession(accountId: string): Promise<void>;
  listSessions(): Promise<BrowserSessionConfig[]>;

  // Attach-before-navigate protocol (6.1)
  attachBeforeNavigate(accountId: string): Promise<void>;
  navigate(accountId: string, url: string): Promise<void>;

  // Target management — exercise page, iframe, dedicated worker, shared worker, service-worker
  listTargets(accountId: string): Promise<TargetInfo[]>;
  attachToTarget(targetId: string, accountId: string): Promise<void>;

  // Network observation — passive Network witness
  onNetworkEvent(handler: (event: NetworkEvent) => void): { dispose: () => void };

  // Isolated-world witness — read-only, no privileged return channel
  installWitness(accountId: string, script: string): Promise<void>;

  // Download handling
  onDownload(handler: (info: { accountId: string; url: string; filename: string; path: string }) => void): { dispose: () => void };

  // Diagnostics
  getCapabilities(): Promise<{ canObserveWorkers: boolean; canObserveServiceWorkers: boolean; canStreamBodies: boolean; debuggerAttached: boolean }>;
}
