/**
 * Window management — diagnostics GUI vs Arena WebContents
 * Arena renderers: sandbox:true, contextIsolation:true, nodeIntegration:false, no app preload API
 * Diagnostics GUI: local app origin, strict CSP, narrow context bridge
 * Open DevTools on Arena WebContents is prohibited because it can detach Electron's debugger
 */

export interface WindowConfig {
  accountId?: string;
  type: 'arena' | 'diagnostics';
  partition?: string;
}

export class WindowManager {
  private windows = new Map<string, WindowConfig>();

  createArenaWindow(accountId: string, partitionPath: string): WindowConfig {
    const config: WindowConfig = {
      accountId,
      type: 'arena',
      partition: `persist:${partitionPath}`,
    };
    const windowId = `arena-${accountId}`;
    this.windows.set(windowId, config);

    // Real Electron would:
    // new BrowserWindow({
    //   webPreferences: {
    //     session: session.fromPartition(`persist:${partitionPath}`),
    //     sandbox: true,
    //     contextIsolation: true,
    //     nodeIntegration: false,
    //     preload: undefined, // no application preload API for Arena renderers
    //   }
    // })
    // Provide separate diagnostics window and capture harness instead of DevTools on Arena WebContents

    console.log(`[WindowManager] Created Arena window account=${accountId} partition=${partitionPath} sandbox=true contextIsolation=true nodeIntegration=false`);
    return config;
  }

  createDiagnosticsWindow(): WindowConfig {
    const config: WindowConfig = {
      type: 'diagnostics',
    };
    const windowId = `diagnostics-${Date.now()}`;
    this.windows.set(windowId, config);

    // Real: load local file with strict CSP, narrow context bridge
    // Diagnostics GUI and MCP call same typed service registry so semantics cannot drift

    console.log('[WindowManager] Created diagnostics window with strict CSP and context bridge');
    return config;
  }

  listWindows(): Array<{ id: string; config: WindowConfig }> {
    return Array.from(this.windows.entries()).map(([id, config]) => ({ id, config }));
  }

  closeWindow(windowId: string): void {
    this.windows.delete(windowId);
  }
}
