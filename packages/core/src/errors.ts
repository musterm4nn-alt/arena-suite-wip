/**
 * Typed error codes shared across the whole archive (plan §12.2).
 * GUI, MCP, and internal services map failures to exactly these codes so
 * semantics cannot drift between operator surfaces.
 */
export const ARCHIVE_ERROR_CODES = [
  'E_SCOPE_MISMATCH',
  'E_AUTH_EXPIRED',
  'E_OWNER_ACTION_REQUIRED',
  'E_RATE_LIMITED',
  'E_CONFIRM_REQUIRED',
  'E_LOCKED',
  'E_DRIFT',
  'E_UNSUPPORTED',
  'E_PARTIAL',
  'E_BUSY',
  'E_NOT_FOUND',
  'E_INVALID_ARGS',
  'E_INTERNAL',
] as const;

export type ArchiveErrorCode = (typeof ARCHIVE_ERROR_CODES)[number];

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ArchiveErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.details = details;
  }
  toJSON(): { error: ArchiveErrorCode; message: string; details?: Record<string, unknown> } {
    return { error: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function isArchiveError(e: unknown): e is ArchiveError {
  return e instanceof ArchiveError;
}

/** Wrap unknown throwables into a safe, structured error (never leaks raw payloads). */
export function toArchiveError(e: unknown, fallback: ArchiveErrorCode = 'E_INTERNAL'): ArchiveError {
  if (e instanceof ArchiveError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new ArchiveError(fallback, msg.slice(0, 400));
}
