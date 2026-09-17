/**
 * Browser-adapter boundary (plan §3/§4): all core services depend on this
 * interface, not on Electron. If the hostile spike proves Electron insufficient,
 * ONLY this adapter is replaced (CEF), never storage/identity/MCP/sync/analysis.
 */
import type { CdpNetworkEvent } from '@arena/schema';

export interface AdapterCapabilities {
  kind: 'electron' | 'cef' | 'mock';
  /** Whether the attach-before-navigate protocol can be fully honored. */
  attachBeforeNavigate: boolean;
  /** Whether flattened auto-attach to workers/service workers is supported. */
  flattenedTargetAttach: boolean;
  /** Whether buffered chunk observation (Network.dataReceived / streamResourceContent) is available. */
  responseBodies: 'full' | 'partial' | 'none';
  isolatedWorldScript: boolean;
  downloadHook: boolean;
  durableMessages: boolean;
  notes: string[];
}

export interface AdapterEvent {
  type: 'cdp' | 'target_attached' | 'target_detached' | 'download' | 'renderer_gone' | 'protocol_step' | 'diagnostic';
  /** CDP event passthrough for type='cdp' */
  cdp?: CdpNetworkEvent;
  /** target events */
  targetId?: string;
  sessionId?: string;
  parentTargetId?: string;
  targetKind?: 'page' | 'iframe' | 'dedicated_worker' | 'shared_worker' | 'service_worker' | 'other';
  /** download */
  download?: { url: string; suggestedFilename: string; contentLength?: number; totalBytes?: number };
  /** diagnostic */
  detail?: Record<string, unknown>;
}

export interface AccountViewOptions {
  accountId: string;
  storagePath: string;   // app-controlled partition dir, never derived from page/email data (§5)
  allowPopupsSamePartition: true;
}

export interface FetchInSessionResult {
  ok: boolean;
  status: number;
  bodyText: string;
  headers: Record<string, string>;
}

export interface AccountView {
  readonly accountId: string;
  capabilities(): AdapterCapabilities;
  /** Whether the debugger is currently attached (DevTools hazard guard, §6.1). */
  isAttached(): boolean;
  /** Record protocol order so the attach verifier can assert §6.1. Implementations MUST emit protocol_step events. */
  attach(): Promise<void>;
  enableNetwork(opts: { bufferSizeBytes: number; durable?: boolean }): Promise<void>;
  enablePage(): Promise<void>;
  enableRuntime(): Promise<void>;
  addIsolatedBinding(name: string, world: string): Promise<void>;
  addScriptOnNewDocument(source: string, world: string): Promise<void>;
  setAutoAttach(opts: { flatten: true; waitForDebuggerOnStart: true }): Promise<void>;
  verifyAcknowledgements(): Promise<{ allAcked: boolean; missing: string[] }>;
  /** The only navigation surface. Open DevTools on Arena views is prohibited (§6.1). */
  navigate(url: string): Promise<void>;
  /** App-owned fetch used by sync read-probes; credentials stay inside Chromium. */
  fetchInSession(input: { url: string; method: 'GET'; headers?: Record<string, string> }): Promise<FetchInSessionResult>;
  onEvent(cb: (e: AdapterEvent) => void): () => void;
  /** Owner-session UI traversal fallback primitive: synthetic click on a witnessed element ref. */
  uiTraversalStep?(step: { action: 'scroll' | 'click'; elementRef: string }): Promise<void>;
  setDevToolsOpen(open: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  readonly kind: AdapterCapabilities['kind'];
  capabilities(): AdapterCapabilities;
  createAccountView(opts: AccountViewOptions): Promise<AccountView>;
  dispose(): Promise<void>;
}
