/**
 * Typed IPC channels — MessagePort / local IPC between Electron main and archive service (utilityProcess)
 * GUI and MCP call same typed service registry
 */

export const IPC_CHANNELS = {
  // Main <-> Archive service
  ARCHIVE_INGEST_OBSERVATION: 'archive:ingest-observation',
  ARCHIVE_GET_STATUS: 'archive:get-status',
  ARCHIVE_BACKUP: 'archive:backup',
  ARCHIVE_RESTORE: 'archive:restore',

  // Main <-> Renderer (diagnostics)
  DIAGNOSTICS_GET_CAPS: 'diagnostics:get-caps',
  DIAGNOSTICS_GET_PROTOCOL_CATALOG: 'diagnostics:get-protocol-catalog',
  DIAGNOSTICS_GET_DRIFT: 'diagnostics:get-drift',
  ACCOUNTS_LIST: 'accounts:list',
  CAPTURE_STATUS: 'capture:status',

  // Key broker
  KEY_UNLOCK: 'key:unlock',
  KEY_LOCK: 'key:lock',
  KEY_STATUS: 'key:status',
} as const;

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];

export interface IpcRequest<T = unknown> {
  channel: IpcChannel;
  payload: T;
  accountId?: string;
  requestId: string;
}

export interface IpcResponse<T = unknown> {
  channel: IpcChannel;
  requestId: string;
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}
