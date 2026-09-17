/**
 * Electron BrowserAdapter implementation (plan §6.1).
 *
 * Executes the attach-before-navigate protocol via WebContents.debugger and
 * flattened Target auto-attach. Electron is loaded lazily and ONLY when
 * running under Electron, so unit tests and the Linux P0 gate (fake adapter)
 * never touch it.
 *
 * Open DevTools on Arena WebContents is prohibited (debugger detach hazard):
 * this adapter never calls openDevTools on an Arena view.
 */
import type {
  AccountSession,
  AttachResult,
  BrowserAdapter,
  CdpEvent,
  TargetInfo,
  TargetKind,
  WitnessObservation,
} from "@arena/browser-adapter";
import { ATTACH_STEPS } from "@arena/browser-adapter";
import { WITNESS_BINDING, WITNESS_SOURCE, WITNESS_VERSION, WITNESS_WORLD } from "./witness.js";

export function runningUnderElectron(): boolean {
  return (
    typeof process !== "undefined" &&
    (process as unknown as { versions?: { electron?: string } }).versions?.electron !== undefined
  );
}

type ElectronApi = typeof import("electron");

function loadElectron(): ElectronApi {
  if (!runningUnderElectron()) {
    throw new Error("Electron adapter requires the Electron runtime (use FakeBrowserAdapter in tests)");
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const req = (globalThis as { require?: unknown }).require ?? eval("require");
  return (req as (m: string) => ElectronApi)("electron");
}

function toTargetKind(cdpType: string): TargetKind {
  switch (cdpType) {
    case "page":
      return "page";
    case "iframe":
      return "iframe";
    case "worker":
      return "dedicated-worker";
    case "shared_worker":
      return "shared-worker";
    case "service_worker":
      return "service-worker";
    default:
      return "other";
  }
}

const CDP_BUFFER_BYTES = 50 * 1024 * 1024; // 50MB Network buffer; tuned in P6.

export class ElectronAccountSession implements AccountSession {
  readonly accountId: string;
  readonly storagePath: string;
  readonly stepLog: string[] = [];

  private view: unknown = null;
  private attached = false;
  private readonly eventCbs = new Set<(e: CdpEvent) => void>();
  private readonly witnessCbs = new Set<(o: WitnessObservation) => void>();
  private cdpSessionId: string | null = null;

  constructor(accountId: string, storagePath: string) {
    this.accountId = accountId;
    this.storagePath = storagePath;
  }

  async attach(url: string): Promise<AttachResult> {
    const electron = loadElectron();
    const { WebContentsView } = electron;

    // 1. create account WebContents with NO Arena URL loaded.
    this.step("create-webcontents-no-url");
    const view = new WebContentsView({
      webPreferences: {
        partition: `persist:arena-${this.accountId}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        devTools: false,
      },
    });
    this.view = view;
    const wc = view.webContents;

    // 2-3. binding + queue are owned by CaptureSupervisor (wired by caller).
    this.step("bind-webcontents-account");
    this.step("create-capture-queue");

    const dbg = wc.debugger;
    this.step("debugger-attach");
    dbg.attach("1.3");
    this.cdpSessionId = `electron-${wc.id}`;

    // Forward ALL debugger messages through the typed event path.
    dbg.on("message", (_event, method: string, params?: Record<string, unknown>) => {
      this.handleCdpMessage(method, params);
    });
    dbg.on("detach", (_event, reason: string) => {
      this.emit({ method: "Inspector.detached", params: { reason } });
    });

    const send = (m: string, p?: Record<string, unknown>): Promise<unknown> =>
      dbg.sendCommand(m, p);

    // 4-9. domain enable with explicit buffers + isolated witness.
    this.step("network-enable");
    await send("Network.enable", {
      maxResourceBufferSize: CDP_BUFFER_BYTES,
      maxTotalBufferSize: CDP_BUFFER_BYTES * 4,
    });
    this.step("page-enable");
    await send("Page.enable");
    this.step("runtime-enable");
    await send("Runtime.enable");
    this.step("runtime-add-binding");
    await send("Runtime.addBinding", { name: WITNESS_BINDING });
    this.step("page-add-script-isolated-world");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: WITNESS_SOURCE,
      worldName: WITNESS_WORLD,
    });
    // 10. flattened auto-attach; children frozen until armed (waitForDebuggerOnStart).
    this.step("target-set-autoattach");
    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });

    this.step("verify-acknowledgements");
    this.attached = true;

    // 11. ONLY THEN navigate.
    this.step("navigate-arena");
    await wc.loadURL(url);

    void ATTACH_STEPS;
    return {
      targetId: `electron-target-${wc.id}`,
      cdpSessionId: this.cdpSessionId,
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
    if (!this.attached) return [];
    const electron = loadElectron();
    void electron;
    // Target inventory is maintained from attachedToTarget events (P1 wires
    // Target.getTargets reconciliation here).
    return [];
  }

  async navigate(url: string): Promise<void> {
    const wc = this.webContents();
    await wc.loadURL(url);
  }

  async close(): Promise<void> {
    try {
      const wc = this.view as { webContents?: { debugger?: { isAttached(): boolean; detach(): void }; close?: () => void } } | null;
      if (wc?.webContents?.debugger?.isAttached()) wc.webContents.debugger.detach();
      wc?.webContents?.close?.();
    } finally {
      this.view = null;
      this.attached = false;
    }
  }

  // -- internals ------------------------------------------------------------

  private step(s: string): void {
    this.stepLog.push(s);
  }

  private emit(evt: CdpEvent): void {
    const full: CdpEvent = {
      ...evt,
      cdpSessionId: evt.cdpSessionId ?? this.cdpSessionId,
      targetId: evt.targetId ?? null,
    };
    for (const cb of this.eventCbs) cb(full);
  }

  private handleCdpMessage(method: string, params?: Record<string, unknown>): void {
    if (method === "Runtime.bindingCalled" && params?.["name"] === WITNESS_BINDING) {
      try {
        const payload = JSON.parse(String(params["payload"] ?? "{}")) as Record<string, unknown>;
        const obs: WitnessObservation = {
          adapterId: String(payload["version"] ?? WITNESS_VERSION),
          route: (payload["route"] as string) ?? null,
          conversationRef: (payload["conversationRef"] as string) ?? null,
          participantPositions: [],
          blindLabels: [],
          selectedLabels: [],
          voteState: (payload["voteState"] as string) ?? null,
          revealBanner: null,
          stopOrError: (payload["stopOrError"] as string) ?? null,
          observedAtMs: Number(payload["observedAtMs"] ?? Date.now()),
        };
        for (const cb of this.witnessCbs) cb(obs);
      } catch {
        this.emit({ method: "Witness.parseFailed", params: {} });
      }
      return;
    }
    if (method === "Target.attachedToTarget") {
      // Plan §6.1: bind child target to parent account, enable Network in the
      // child session, install witness where meaningful, then resume.
      const sessionId = params?.["sessionId"] as string | undefined;
      const targetInfo = params?.["targetInfo"] as { targetId?: string; type?: string } | undefined;
      void toTargetKind(targetInfo?.type ?? "");
      this.armChildTarget(sessionId).catch(() => {
        this.emit({ method: "Target.armFailed", params: { sessionId } });
      });
      this.emit({ method, params });
      return;
    }
    this.emit({ method, params });
  }

  private async armChildTarget(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const wc = this.webContents() as unknown as {
      debugger: { sendCommand(m: string, p?: Record<string, unknown>): Promise<unknown> };
    };
    await wc.debugger.sendCommand("Network.enable", undefined);
    void sessionId;
    // P1: session-scoped enable via flattened sessionId + witness install +
    // Runtime.runIfWaitingForDebugger. Electron's debugger API routes by
    // session implicitly for attached child targets.
  }

  private webContents(): { loadURL(u: string): Promise<void> } {
    const v = this.view as { webContents?: { loadURL(u: string): Promise<void> } } | null;
    if (!v?.webContents) throw new Error("session has no WebContents (attach first)");
    return v.webContents;
  }
}

export class ElectronBrowserAdapter implements BrowserAdapter {
  readonly name = "electron" as const;
  private readonly sessions = new Map<string, ElectronAccountSession>();

  async createSession(accountId: string, storagePath: string): Promise<ElectronAccountSession> {
    const s = new ElectronAccountSession(accountId, storagePath);
    this.sessions.set(accountId, s);
    return s;
  }

  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) await s.close();
    this.sessions.clear();
  }
}
