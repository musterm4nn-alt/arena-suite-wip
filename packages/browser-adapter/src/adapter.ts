/**
 * @arena/browser-adapter — browser-adapter interface (plan §3, §6).
 *
 * Core services (storage, identity, MCP, sync, analysis) depend ONLY on this
 * interface. If the P0 spike proves Electron insufficient, only the adapter
 * implementation is replaced (CEF); nothing above this boundary changes.
 */

export type TargetKind =
  | "page"
  | "iframe"
  | "dedicated-worker"
  | "shared-worker"
  | "service-worker"
  | "other";

export interface TargetInfo {
  targetId: string;
  kind: TargetKind;
  url: string;
}

export interface CdpEvent {
  method: string;
  params?: unknown;
  cdpSessionId?: string | null;
  targetId?: string | null;
}

export interface AttachResult {
  targetId: string;
  cdpSessionId: string;
  /** True only when attach+domain-enable ACKed BEFORE first navigation. */
  attachedBeforeNavigate: boolean;
}

export interface WitnessObservation {
  /** Versioned DOM adapter id, e.g. "arena-dom@v1". */
  adapterId: string;
  route: string | null;
  conversationRef: string | null;
  participantPositions: string[];
  blindLabels: (string | null)[];
  selectedLabels: (string | null)[];
  voteState: string | null;
  revealBanner: string | null;
  stopOrError: string | null;
  observedAtMs: number;
}

/**
 * Account-scoped browser session owned by the app. One persistent session per
 * account (plan §5): cookies, storage, cache, SW registrations stay
 * partition-scoped. Implementations MUST NOT derive storage paths from page data.
 */
export interface AccountSession {
  readonly accountId: string;
  /** App-controlled storage directory for this account's partition. */
  readonly storagePath: string;

  /** Attach-before-navigate (plan §6.1). Must resolve only after ACKs verified. */
  attach(url: string): Promise<AttachResult>;
  onEvent(cb: (evt: CdpEvent) => void): () => void;
  onWitness(cb: (obs: WitnessObservation) => void): () => void;
  listTargets(): Promise<TargetInfo[]>;
  navigate(url: string): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserAdapter {
  readonly name: "electron" | "cef" | "fake";
  createSession(accountId: string, storagePath: string): Promise<AccountSession>;
  dispose(): Promise<void>;
}
