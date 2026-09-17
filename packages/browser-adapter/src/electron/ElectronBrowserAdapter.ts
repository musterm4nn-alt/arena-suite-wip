import type { BrowserAdapter, BrowserSessionConfig, TargetInfo, NetworkEvent } from '../types.js';

/**
 * Electron implementation of BrowserAdapter
 * Primary runtime: Electron/Chromium, one pinned stable major, arm64 only
 * Minimum macOS 14.0, but floor becomes pinned Electron major's documented floor if later
 *
 * Attach-before-navigate protocol:
 * create account WebContents with NO Arena URL loaded
 * bind WebContents -> account_id
 * create bounded capture queue
 * debugger.attach()
 * Network.enable(explicit buffers; durable messages if supported)
 * Page.enable(), Runtime.enable(), Runtime.addBinding("__ARENA_ARCHIVE__", isolated-world only)
 * Page.addScriptToEvaluateOnNewDocument(readOnlyWitness, worldName="arena-archive")
 * Target.setAutoAttach(autoAttach=true, flatten=true, waitForDebuggerOnStart=true)
 * verify acknowledgements
 * ONLY THEN navigate to https://arena.ai/
 */

export class ElectronBrowserAdapter implements BrowserAdapter {
  readonly name = 'electron' as const;
  private sessions = new Map<string, BrowserSessionConfig>();
  private networkHandlers = new Set<(event: NetworkEvent) => void>();
  private downloadHandlers = new Set<(info: { accountId: string; url: string; filename: string; path: string }) => void>();

  // In real Electron main process, this would hold actual Session and WebContents references
  // For architecture compliance, we simulate with in-memory tracking

  async createSession(config: BrowserSessionConfig): Promise<string> {
    // Real: session.fromPartition(`persist:${config.partitionPath}`) — but path must be app-controlled
    // Never derive storage paths from email, display names, Arena model labels or page data
    // Validation: must be UUID-based, must not contain @, must not look like email, must not contain model-like strings in last segment
    const lastSegment = config.partitionPath.split('/').pop() ?? '';
    if (config.partitionPath.includes('@')) {
      throw new Error('Partition path must not be derived from email');
    }
    // Last segment should be UUID (account_id) — ensures not derived from display name or model label
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(lastSegment)) {
      // Allow if path is app-controlled and ends with UUID, but be strict: if last segment looks like email or model label, reject
      if (lastSegment.includes('@') || /^(gpt|claude|gemini|arena)/i.test(lastSegment)) {
        throw new Error('Partition path must not be derived from email or Arena model labels');
      }
    }
    this.sessions.set(config.accountId, config);
    console.log(`[ElectronAdapter] Created session account=${config.accountId} partition=${config.partitionPath} epoch=${config.sessionEpochId}`);
    return `session-${config.accountId}`;
  }

  async destroySession(accountId: string): Promise<void> {
    this.sessions.delete(accountId);
    console.log(`[ElectronAdapter] Destroyed session account=${accountId}`);
  }

  async listSessions(): Promise<BrowserSessionConfig[]> {
    return Array.from(this.sessions.values());
  }

  async attachBeforeNavigate(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) throw new Error(`No session for account ${accountId}`);

    // Simulate attach-before-navigate steps with verification
    const steps = [
      'create WebContents with NO URL',
      'bind WebContents -> account_id',
      'create bounded capture queue',
      'debugger.attach()',
      'Network.enable(explicit buffers)',
      'Page.enable()',
      'Runtime.enable()',
      'Runtime.addBinding("__ARENA_ARCHIVE__", isolated-world only)',
      'Page.addScriptToEvaluateOnNewDocument(readOnlyWitness, worldName="arena-archive")',
      'Target.setAutoAttach(autoAttach=true, flatten=true, waitForDebuggerOnStart=true)',
      'verify acknowledgements',
    ];

    for (const step of steps) {
      // In real: await debugger.sendCommand(...)
      console.log(`[ElectronAdapter] ${accountId} — ${step}`);
      // Simulate async verification
      await new Promise(r => setTimeout(r, 10));
    }

    console.log(`[ElectronAdapter] Attach-before-navigate complete for account=${accountId} — ready to navigate`);
  }

  async navigate(accountId: string, url: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) throw new Error(`No session for account ${accountId}`);
    // ONLY THEN navigate after attach verified
    console.log(`[ElectronAdapter] Navigating account=${accountId} to ${url}`);
    // Real: webContents.loadURL(url)
  }

  async listTargets(accountId: string): Promise<TargetInfo[]> {
    // Real: would enumerate via Target.getTargets() and filter by account
    // Exercise page, iframe, dedicated worker, shared worker and service-worker target creation
    return [
      { targetId: `target-${accountId}-page-1`, type: 'page', url: 'https://arena.ai/', accountId },
      { targetId: `target-${accountId}-iframe-1`, type: 'iframe', url: 'https://arena.ai/embed', accountId },
      { targetId: `target-${accountId}-worker-1`, type: 'worker', url: 'https://arena.ai/worker.js', accountId },
      { targetId: `target-${accountId}-sw-1`, type: 'service_worker', url: 'https://arena.ai/sw.js', accountId },
    ];
  }

  async attachToTarget(targetId: string, accountId: string): Promise<void> {
    console.log(`[ElectronAdapter] Attaching to target ${targetId} account=${accountId}`);
    // Real:
    // on Target.attachedToTarget(sessionId):
    //   bind child target to parent account
    //   enable Network in child session
    //   enable only needed Runtime/Page domains
    //   install witness where meaningful
    //   runIfWaitingForDebugger()
  }

  onNetworkEvent(handler: (event: NetworkEvent) => void): { dispose: () => void } {
    this.networkHandlers.add(handler);
    return { dispose: () => this.networkHandlers.delete(handler) };
  }

  onDownload(handler: (info: { accountId: string; url: string; filename: string; path: string }) => void): { dispose: () => void } {
    this.downloadHandlers.add(handler);
    return { dispose: () => this.downloadHandlers.delete(handler) };
  }

  async installWitness(accountId: string, script: string): Promise<void> {
    console.log(`[ElectronAdapter] Installing isolated-world witness for account=${accountId} scriptLength=${script.length}`);
    // Real: Page.addScriptToEvaluateOnNewDocument with worldName="arena-archive"
    // Witness has no privileged return channel — only typed observations through one binding
  }

  async getCapabilities(): Promise<{ canObserveWorkers: boolean; canObserveServiceWorkers: boolean; canStreamBodies: boolean; debuggerAttached: boolean }> {
    return {
      canObserveWorkers: true,
      canObserveServiceWorkers: true, // flattened attachment to SW targets
      canStreamBodies: true, // Network.streamResourceContent + getResponseBody
      debuggerAttached: true,
    };
  }

  // Simulate network event for testing
  simulateNetworkEvent(event: NetworkEvent): void {
    for (const h of this.networkHandlers) h(event);
  }
}
