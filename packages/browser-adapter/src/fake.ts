/**
 * Fake adapter for P0 gate + unit tests: replays scripted CDP/witness events
 * through the real CaptureRouter + ledger path. Also used to prove two-account
 * sentinel isolation without a browser.
 */
import type {
  AccountSession,
  AttachResult,
  BrowserAdapter,
  CdpEvent,
  TargetInfo,
  WitnessObservation,
} from "./adapter.js";
import { ATTACH_STEPS } from "./attach.js";

export class FakeAccountSession implements AccountSession {
  readonly accountId: string;
  readonly storagePath: string;
  readonly stepLog: string[] = [];
  private readonly eventCbs = new Set<(e: CdpEvent) => void>();
  private readonly witnessCbs = new Set<(o: WitnessObservation) => void>();
  private readonly targets: TargetInfo[] = [];
  private closed = false;
  /** Per-session storage sentinel (isolation test). */
  readonly sentinel: string;

  constructor(accountId: string, storagePath: string) {
    this.accountId = accountId;
    this.storagePath = storagePath;
    this.sentinel = `sentinel:${accountId}`;
  }

  async attach(url: string): Promise<AttachResult> {
    for (const step of ATTACH_STEPS) {
      if (step === "navigate-arena") break;
      this.stepLog.push(step);
    }
    this.targets.push({ targetId: `t-${this.accountId}-page`, kind: "page", url: "about:blank" });
    // Simulate flattened child targets (plan §6.1 on attachedToTarget).
    for (const kind of ["iframe", "dedicated-worker", "shared-worker", "service-worker"] as const) {
      this.targets.push({ targetId: `t-${this.accountId}-${kind}`, kind, url });
    }
    this.stepLog.push("navigate-arena");
    this.targets[0]!.url = url;
    return {
      targetId: this.targets[0]!.targetId,
      cdpSessionId: `sess-${this.accountId}`,
      attachedBeforeNavigate: true,
    };
  }

  onEvent(cb: (e: CdpEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => {
      this.eventCbs.delete(cb);
    };
  }

  onWitness(cb: (o: WitnessObservation) => void): () => void {
    this.witnessCbs.add(cb);
    return () => {
      this.witnessCbs.delete(cb);
    };
  }

  async listTargets(): Promise<TargetInfo[]> {
    return [...this.targets];
  }

  async navigate(url: string): Promise<void> {
    if (this.closed) throw new Error("session closed");
    this.stepLog.push(`navigate:${url}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // -- script drivers -------------------------------------------------------

  emit(evt: CdpEvent): void {
    for (const cb of this.eventCbs) cb(evt);
  }

  emitWitness(obs: WitnessObservation): void {
    for (const cb of this.witnessCbs) cb(obs);
  }
}

export class FakeBrowserAdapter implements BrowserAdapter {
  readonly name = "fake" as const;
  readonly sessions = new Map<string, FakeAccountSession>();

  async createSession(accountId: string, storagePath: string): Promise<FakeAccountSession> {
    const s = new FakeAccountSession(accountId, storagePath);
    this.sessions.set(accountId, s);
    return s;
  }

  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) await s.close();
    this.sessions.clear();
  }
}
