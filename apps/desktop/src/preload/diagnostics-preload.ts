/**
 * Diagnostics preload — narrow context bridge, strict CSP
 * GUI and MCP call same typed service registry so semantics cannot drift
 * No generic arbitrary JS, HTTP request, raw SQL or shell execution
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, type IpcChannel } from '../ipc/channels.js';

const allowedChannels: IpcChannel[] = [
  IPC_CHANNELS.DIAGNOSTICS_GET_CAPS,
  IPC_CHANNELS.DIAGNOSTICS_GET_PROTOCOL_CATALOG,
  IPC_CHANNELS.DIAGNOSTICS_GET_DRIFT,
  IPC_CHANNELS.ACCOUNTS_LIST,
  IPC_CHANNELS.CAPTURE_STATUS,
  IPC_CHANNELS.KEY_STATUS,
];

const api = {
  invoke: async (channel: IpcChannel, args?: unknown) => {
    if (!allowedChannels.includes(channel)) {
      throw new Error(`Channel ${channel} not allowed in diagnostics preload`);
    }
    return ipcRenderer.invoke(channel, args);
  },
  // No arbitrary execution
};

contextBridge.exposeInMainWorld('api', api);

export type DiagnosticsApi = typeof api;
