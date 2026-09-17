/**
 * Sanitization before persistence — non-negotiable rule #4 and section 11.2
 * Drop — not merely redact later — sensitive headers and secrets.
 * Parser failures never trigger raw dumps.
 */

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
  'x-xsrf-token',
  'cookie2',
]);

const SENSITIVE_KEYS_REGEX = /(password|passwd|secret|bearer|token|mfa|otp|verification_code|email_code|csrf|api_key)/i;

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'id_token',
  'code',
  'auth',
  'signature',
  'sig',
  'key',
  'api_key',
  'session',
  'sess',
]);

export interface SanitizedResult {
  sanitized: unknown;
  droppedKeys: string[];
  error?: string;
}

export class Sanitizer {
  /**
   * Fail-closed sanitization: if payload cannot be safely projected, persist only
   * error code, byte length and shape hash — never dump raw bytes.
   */
  static sanitizeJson(input: unknown): SanitizedResult {
    const droppedKeys: string[] = [];
    try {
      const sanitized = this.walk(input, droppedKeys, 0);
      return { sanitized, droppedKeys };
    } catch (e) {
      return {
        sanitized: {
          _sanitization_failed: true,
          error_code: 'SANITIZE_FAILED',
          byte_length: JSON.stringify(input)?.length ?? 0,
        },
        droppedKeys,
        error: (e as Error).message,
      };
    }
  }

  private static walk(value: unknown, dropped: string[], depth: number): unknown {
    if (depth > 20) {
      dropped.push('<max_depth>');
      return '[REDACTED_MAX_DEPTH]';
    }
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      // Heuristic: if string looks like a bearer token or secret URL, drop
      if (value.length > 200 && /^[A-Za-z0-9\-_]{100,}$/.test(value)) {
        dropped.push('<long_token_string>');
        return '[REDACTED_TOKEN]';
      }
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      return value.map(v => this.walk(v, dropped, depth + 1));
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const lower = k.toLowerCase();
        if (SENSITIVE_HEADERS.has(lower) || SENSITIVE_KEYS_REGEX.test(k) || SENSITIVE_QUERY_KEYS.has(lower)) {
          dropped.push(k);
          out[k] = '[REDACTED]';
          continue;
        }
        out[k] = this.walk(v, dropped, depth + 1);
      }
      return out;
    }
    return value;
  }

  static sanitizeHeaders(headers: Record<string, string>): { sanitized: Record<string, string>; dropped: string[] } {
    const sanitized: Record<string, string> = {};
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(headers)) {
      if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
        dropped.push(k);
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = v;
      }
    }
    return { sanitized, dropped };
  }

  /**
   * Canary test helper — ensure secret does not leak through success/error paths.
   */
  static containsSecret(text: string, secret: string): boolean {
    return text.includes(secret);
  }
}
