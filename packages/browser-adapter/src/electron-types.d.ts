/**
 * Minimal ambient declarations for the electron module so this package
 * typechecks without installing the (arm64, macOS-flavored) electron binary.
 * The real build pins one stable major and replaces this file with `electron`'s
 * own types; do NOT widen these.
 */
declare module 'electron' {
  export const app: {
    getPath(name: string): string;
    whenReady(): Promise<void>;
    on(event: string, cb: (...a: unknown[]) => void): void;
  };
  export const session: {
    fromPartition(partition: string, opts?: { cache?: boolean; partition?: string }): ElectronSession;
  };
  export interface ElectronSession {
    setPermissionRequestHandler(cb: (wc: unknown, permission: string, cb2: (granted: boolean) => void) => void): void;
    on(event: string, cb: (...a: unknown[]) => void): void;
  }
  export class WebContentsView {
    webContents: ElectronWebContents;
    constructor(opts?: { webPreferences?: Record<string, unknown> });
  }
  export interface ElectronWebContents {
    session: ElectronSession;
    loadURL(url: string): Promise<void>;
    on(event: string, cb: (...a: unknown[]) => void): void;
    once(event: string, cb: (...a: unknown[]) => void): void;
    isDevToolsOpened(): boolean;
    openDevTools(): void;
    close(): void;
    debugger: {
      attach(): void;
      detach(): void;
      isAttached(): boolean;
      sendCommand(method: string, params?: Record<string, unknown>): Promise<{ ack: boolean }>;
      on(event: string, cb: (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
    };
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  }
  export class BrowserWindow { constructor(opts?: Record<string, unknown>); webContents: ElectronWebContents; show(): void; loadURL(url: string): Promise<void>; }
  export const utilityProcess: { fork(modulePath: string, args?: string[], opts?: Record<string, unknown>): { postMessage(m: unknown): void; on(event: string, cb: (...a: unknown[]) => void): void; kill(): void } };
  export const shell: { showItemInFolder(p: string): void };
}
