/**
 * Typed errors per section 12.2
 */

export type McpErrorCode =
  | 'E_SCOPE_MISMATCH'
  | 'E_AUTH_EXPIRED'
  | 'E_OWNER_ACTION_REQUIRED'
  | 'E_RATE_LIMITED'
  | 'E_CONFIRM_REQUIRED'
  | 'E_LOCKED'
  | 'E_DRIFT'
  | 'E_UNSUPPORTED'
  | 'E_PARTIAL'
  | 'E_BUSY';

export class McpError extends Error {
  constructor(
    public code: McpErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpError';
  }

  toJson(): { code: McpErrorCode; message: string; details?: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}
