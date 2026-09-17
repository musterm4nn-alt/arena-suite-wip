import { sha256Hex, canonicalJson } from '@arena/core';

/**
 * Sanitization BEFORE persistence (plan §11.2): secrets are *dropped*, not redacted.
 * Fail-closed: if a payload cannot be safely projected, callers must persist only
 * error code + byte length + shape hash — never raw bytes for convenience (§8).
 */

const SECRET_KEY_RE =
  /(^|[_\-.])(password|passwd|secret|api[_-]?key|apikey|authorization|cookie|csrf|xsrf|session[_-]?id|sessionid|mfa|otp|totp|access[_-]?token|refresh[_-]?token|bearer|id[_-]?token|verification[_-]?code|recovery[_-]?code)([_\-.]|$)/i;

const SECRET_VALUE_RES: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-]{10,}/i,
  /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/, // JWT-ish
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b[A-Za-z0-9+\/]{40,}={0,2}\b(?=.*\bsignature\b)/i,
];

const DANGEROUS_URL_PARAMS =
  /(^|[_\-]?)(sig|signature|token|key|expires|expiry|auth|code|secret|access[_-]?key)/i;

/** Header allowlist for anything we keep as metadata. Everything else on the deny list is dropped. */
const DROP_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key', 'x-amz-security-token',
]);
const KEEP_HEADERS = new Set([
  'content-type', 'content-length', 'accept', 'accept-language', 'cache-control',
  'content-disposition', 'retry-after', 'server', 'x-request-id',
]);

export interface SanitizedHeaders {
  kept: Record<string, string>;
  droppedNames: string[];
}

export function sanitizeHeaders(raw: Record<string, unknown>): SanitizedHeaders {
  const kept: Record<string, string> = {};
  const droppedNames: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const lk = k.toLowerCase();
    if (DROP_HEADERS.has(lk) || SECRET_KEY_RE.test(lk) || !KEEP_HEADERS.has(lk)) {
      droppedNames.push(lk);
      continue;
    }
    if (typeof v === 'string' && v.length <= 512) kept[lk] = v;
  }
  return { kept, droppedNames: [...new Set(droppedNames)].sort() };
}

export const MAX_JSON_DEPTH = 24;
export const MAX_JSON_STRING = 64 * 1024;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_JSON_KEYS = 4096;

export type Projection =
  | { ok: true; value: unknown }
  | { ok: false; errorCode: 'PAYLOAD_TOO_LARGE' | 'PAYLOAD_TOO_DEEP' | 'PAYLOAD_TOO_MANY_KEYS' | 'STRING_TOO_LONG' | 'UNSAFE_VALUE'; byteLength: number; shapeHash: string };

/** Project arbitrary JSON into a safe retained shape; drop secrets; fail closed. */
export function sanitizeJsonValue(input: unknown): Projection {
  const byteLength = Buffer.byteLength(typeof input === 'string' ? input : safeStringify(input), 'utf8');
  const sh = sha256Hex(canonicalJson(safeSkeleton(input)));
  let keys = 0;
  const project = (v: unknown, depth: number): unknown => {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? v : 'non_finite';
    if (t === 'boolean') return v;
    if (t === 'string') {
      const s = v as string;
      if (s.length > MAX_JSON_STRING) return { truncated: true, byteLength: Buffer.byteLength(s), sha256: sha256Hex(s) };
      if (SECRET_VALUE_RES.some((re) => re.test(s))) return { droppedSecret: 'string_pattern' };
      return s;
    }
    if (t !== 'object') return { droppedUnsafe: t };
    if (depth > MAX_JSON_DEPTH) throw new ProjectionAbort('PAYLOAD_TOO_DEEP');
    if (Array.isArray(v)) return v.slice(0, 4096).map((x) => project(x, depth + 1));
    if (v instanceof Uint8Array) {
      return { binaryRef: true, byteLength: v.length, sha256: sha256Hex(v) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (++keys > MAX_JSON_KEYS) throw new ProjectionAbort('PAYLOAD_TOO_MANY_KEYS');
      if (SECRET_KEY_RE.test(k)) {
        out[k] = { droppedSecret: 'key_name' };
        continue;
      }
      out[k] = project(val, depth + 1);
    }
    return out;
  };
  try {
    if (byteLength > MAX_JSON_BYTES) {
      return { ok: false, errorCode: 'PAYLOAD_TOO_LARGE', byteLength, shapeHash: sh };
    }
    const value = project(input, 0);
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ProjectionAbort) return { ok: false, errorCode: e.code, byteLength, shapeHash: sh };
    return { ok: false, errorCode: 'UNSAFE_VALUE', byteLength, shapeHash: sh };
  }
}

class ProjectionAbort extends Error {
  code: 'PAYLOAD_TOO_DEEP' | 'PAYLOAD_TOO_MANY_KEYS';
  constructor(code: 'PAYLOAD_TOO_DEEP' | 'PAYLOAD_TOO_MANY_KEYS') { super(code); this.code = code; }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return '[unstringifiable]'; }
}

function safeSkeleton(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return typeof v;
  if (Array.isArray(v)) return v.slice(0, 8).map(safeSkeleton);
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort().slice(0, 64)) o[k] = safeSkeleton((v as Record<string, unknown>)[k]);
  return o;
}

/**
 * A sensitive resource URL becomes a safe reference (§11.2): enough for
 * correlation, useless for replay.
 */
export interface SafeUrlRef {
  host: string;
  path: string;
  queryKeySet: string[];
  queryHash: string;      // hash of full sorted query (values included) for correlation only
  expiryClass: 'none' | 'known_expiry' | 'opaque';
}

export function toSafeUrlRef(rawUrl: string): SafeUrlRef {
  let u: URL;
  try { u = new URL(rawUrl); } catch {
    return { host: 'invalid', path: 'invalid', queryKeySet: [], queryHash: sha256Hex('invalid'), expiryClass: 'none' };
  }
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const hasExpiry = params.some(([k]) => /exp|until|max_age/i.test(k));
  return {
    host: u.hostname.toLowerCase(),
    path: u.pathname,
    queryKeySet: [...new Set(params.map(([k]) => k))],
    queryHash: sha256Hex(canonicalJson(params)),
    expiryClass: hasExpiry ? 'known_expiry' : params.length ? 'opaque' : 'none',
  };
}

export function stripDangerousUrlParams(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const k of [...u.searchParams.keys()]) {
      if (DANGEROUS_URL_PARAMS.test(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch { return 'about:invalid'; }
}

/** Canary scanner used by tests and P3 gates: nothing matching these may reach durable storage. */
export const CANARY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._\-]{10,}/i },
  { name: 'cookie', re: /\bCookie:/i },
  { name: 'set_cookie', re: /\bSet-Cookie:/i },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/ },
  { name: 'private_key', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

export function scanForSecrets(text: string): string[] {
  return CANARY_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}
