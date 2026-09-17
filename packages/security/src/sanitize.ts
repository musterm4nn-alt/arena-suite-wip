/**
 * @arena/security/sanitize — fail-closed sanitization (plan §11.2).
 *
 * Secrets are DROPPED before persistence, not redacted later. If a payload
 * cannot be safely projected, the caller persists only {error code, byte
 * length, shape hash} — never raw bytes for convenience.
 */
import { createHash } from "node:crypto";

/** Headers dropped entirely (case-insensitive). */
const DROPPED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "csrf-token",
]);

/** JSON/body keys dropped entirely (case-insensitive substring on key path leaf). */
const DROPPED_KEY_PATTERNS = [
  "password",
  "passwd",
  "mfa",
  "otp",
  "verificationcode",
  "verification_code",
  "oauth",
  "refreshtoken",
  "refresh_token",
  "accesstoken",
  "access_token",
  "bearertoken",
  "bearer_token",
  "bearer",
  "csrf",
  "xsrf",
  "sessiontoken",
  "session_token",
  "set-cookie",
  "cookie",
  "secret",
  "privatekey",
  "private_key",
  "apikey",
  "api_key",
  "apitoken",
  "api_token",
];

/** Query params whose VALUES are secret (replaced by presence marker). */
const SECRET_QUERY_PARAMS = new Set([
  "token",
  "auth",
  "signature",
  "sig",
  "key",
  "secret",
  "code",
  "session",
  "sessionid",
  "session_id",
  "expires",
  "expiry",
]);

export interface SafeRef {
  host: string;
  path: string;
  /** Sorted query keys present (values never included for secret params). */
  queryKeySet: string[];
  /** sha256 over the full original query string (correlation, not replay). */
  queryHash: string | null;
  expiryClass: "short" | "long" | "none" | "unknown";
}

export interface SanitizeFailure {
  ok: false;
  errorCode: string;
  byteLength: number;
  shapeHash: string;
}

/** Sanitize a header map. Returns a NEW object; secrets are absent, not masked. */
export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (DROPPED_HEADERS.has(rawKey.toLowerCase())) continue;
    out[rawKey] = Array.isArray(value) ? value.join("; ") : value;
  }
  return out;
}

function isDroppedKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_.]/g, "");
  return DROPPED_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Deep-project a JSON-ish value, dropping secret keys. Returns a sanitized
 * clone. Throws SanitizeError when the value cannot be safely projected
 * (unsupported type at depth, excessive depth, ...).
 */
export class SanitizeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SanitizeError";
    this.code = code;
  }
}

const MAX_DEPTH = 64;
const MAX_KEYS = 50_000;

export function sanitizeJson(value: unknown): unknown {
  const state = { keys: 0 };
  return walk(value, 0, state);
}

function walk(value: unknown, depth: number, state: { keys: number }): unknown {
  if (depth > MAX_DEPTH) {
    throw new SanitizeError("E_DEPTH", "value exceeds max sanitizer depth");
  }
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    case "object": {
      if (value instanceof Uint8Array) {
        // Binary evidence is referenced by hash, never inlined raw.
        return {
          __binary__: true,
          byteLength: value.byteLength,
          sha256: createHash("sha256").update(value).digest("hex"),
        };
      }
      if (Array.isArray(value)) {
        return value.map((v) => walk(v, depth + 1, state));
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        state.keys += 1;
        if (state.keys > MAX_KEYS) {
          throw new SanitizeError("E_TOO_MANY_KEYS", "value exceeds max key count");
        }
        if (isDroppedKey(k)) continue;
        out[k] = walk(v, depth + 1, state);
      }
      return out;
    }
    default:
      // functions, symbols... cannot be projected.
      throw new SanitizeError("E_UNPROJECTABLE", `cannot project ${typeof value}`);
  }
}

/**
 * Project a URL into a correlation-safe reference. Secret query values are
 * never retained; the full query is hashed for correlation.
 */
export function toSafeRef(rawUrl: string): SafeRef | SanitizeFailure {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      errorCode: "E_BAD_URL",
      byteLength: rawUrl.length,
      shapeHash: shapeHashOfString(rawUrl),
    };
  }
  const keys = [...parsed.searchParams.keys()].sort();
  const query = parsed.search;
  return {
    host: parsed.host.toLowerCase(),
    path: parsed.pathname,
    queryKeySet: [...new Set(keys)],
    queryHash: query
      ? createHash("sha256").update(query).digest("hex")
      : null,
    expiryClass: guessExpiryClass(parsed.searchParams),
  };
}

function guessExpiryClass(params: URLSearchParams): SafeRef["expiryClass"] {
  const expKeys = ["expires", "expiry", "exp", "valid_until", "deadline"];
  for (const k of expKeys) {
    const v = params.get(k);
    if (v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) return "unknown";
    // Heuristic: epoch seconds vs short TTL seconds.
    if (n > 1_000_000_000) return "long";
    if (n <= 0) return "unknown";
    if (n < 3600 * 6) return "short";
    return "long";
  }
  return SECRET_QUERY_PARAMS.size > 0 && hasSecretParam(params) ? "unknown" : "none";
}

function hasSecretParam(params: URLSearchParams): boolean {
  for (const k of params.keys()) {
    if (SECRET_QUERY_PARAMS.has(k.toLowerCase())) return true;
  }
  return false;
}

export function shapeHashOfString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Stable shape hash over a JSON value's STRUCTURE (keys + scalar types). */
export function shapeHashOfJson(value: unknown): string {
  return createHash("sha256").update(stableShape(value), "utf8").digest("hex");
}

function stableShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableShape).join(",")}]`;
  }
  switch (typeof value) {
    case "string":
      return "str";
    case "number":
      return "num";
    case "boolean":
      return "bool";
    case "bigint":
      return "bigint";
    case "undefined":
      return "undef";
    case "object": {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableShape((value as Record<string, unknown>)[k])}`).join(",")}}}`;
    }
    default:
      return typeof value;
  }
}
