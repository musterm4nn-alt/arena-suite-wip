/**
 * Narrow context bridge for the diagnostics GUI (plan §4).
 *
 * The GUI calls the SAME typed service commands as MCP (parity). This bridge
 * exposes a minimal invoke() over IPC — no node, no fs, no keys.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("arenaArchive", {
  invoke: (tool: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("arena:invoke", { tool, input }),
  capabilities: (): Promise<unknown> =>
    ipcRenderer.invoke("arena:invoke", { tool: "diagnostics_capabilities", input: {} }),
});
