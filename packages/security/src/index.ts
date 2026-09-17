import { createHash, randomBytes } from "node:crypto";

/**
 * Sanitization per §11.2
 * Drop—not merely redact later—Authorization, Cookie, Set-Cookie, passwords, MFA/verification codes, OAuth codes, CSRF/security tokens, copied bearer strings and secret signed-URL parameters.
 */

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
  "x-xsrf-token",
  "x-auth-token",
  "x-api-key",
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "id_token",
  "code",
  "password",
  "secret",
  "signature",
  "sig",
  "key",
  "auth",
  "session",
  "bearer",
  "otp",
  "mfa",
  "verification",
  "email_code",
]);

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_HEADERS.has(lk)) continue;
    if (lk.includes("auth") || lk.includes("cookie") || lk.includes("csrf") || lk.includes("xsrf")) continue;
    // keep safe headers
    out[k] = v;
  }
  return out;
}

export interface SafeUrlRef {
  host: string;
  path: string;
  query_key_set: string[];
  query_hash: string;
  expiry_class: string;
}

export function toSafeUrlRef(rawUrl: string): SafeUrlRef {
  try {
    const u = new URL(rawUrl);
    const keys = Array.from(u.searchParams.keys()).sort();
    // drop sensitive keys from set? Actually keep key set but hash values separately; for safe ref we keep key set but without sensitive values
    const safeKeys = keys.filter((k) => !SENSITIVE_QUERY_KEYS.has(k.toLowerCase()));
    // hash full query string for correlation but not replay
    const queryHash = createHash("sha256").update(u.search).digest("hex").slice(0, 16);
    // expiry class heuristic
    let expiry_class = "none";
    const exp = u.searchParams.get("expires") || u.searchParams.get("exp") || u.searchParams.get("Expires");
    if (exp) expiry_class = "has_expiry";
    if (u.searchParams.has("X-Amz-Expires") || u.searchParams.has("Expires")) expiry_class = "signed_url";

    return {
      host: u.host,
      path: u.pathname,
      query_key_set: safeKeys,
      query_hash: queryHash,
      expiry_class,
    };
  } catch {
    return {
      host: "invalid",
      path: "/",
      query_key_set: [],
      query_hash: createHash("sha256").update(rawUrl).digest("hex").slice(0, 16),
      expiry_class: "invalid",
    };
  }
}

export function sanitizeJsonPayload(payload: unknown): { sanitized: unknown; dropped: string[]; shape_hash: string } {
  const dropped: string[] = [];
  function walk(obj: any, path: string): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object") {
      // check if string looks like bearer/token
      if (typeof obj === "string" && obj.length > 20) {
        const low = path.toLowerCase();
        if (low.includes("token") || low.includes("password") || low.includes("secret") || low.includes("auth") || low.includes("code") || low.includes("bearer")) {
          dropped.push(path);
          return undefined;
        }
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((v, i) => walk(v, `${path}[${i}]`)).filter((v) => v !== undefined);
    }
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (SENSITIVE_QUERY_KEYS.has(lk) || lk.includes("password") || lk.includes("secret") || lk === "authorization" || lk === "cookie" || lk.includes("csrf")) {
        dropped.push(`${path}.${k}`);
        continue;
      }
      const walked = walk(v, `${path}.${k}`);
      if (walked !== undefined) out[k] = walked;
    }
    return out;
  }

  const sanitized = walk(payload, "$");
  const shape_hash = createHash("sha256")
    .update(JSON.stringify(sanitized, Object.keys(sanitized ?? {}).sort()))
    .digest("hex")
    .slice(0, 16);
  return { sanitized, dropped, shape_hash };
}

export function failClosedSanitize(payload: unknown, maxBytes = 1024 * 1024): { error_code: string; byte_length: number; shape_hash: string } {
  const str = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  const byte_length = Buffer.byteLength(str);
  if (byte_length > maxBytes) {
    return {
      error_code: "PAYLOAD_TOO_LARGE",
      byte_length,
      shape_hash: createHash("sha256").update(str.slice(0, 1000)).digest("hex").slice(0, 16),
    };
  }
  try {
    const { shape_hash } = sanitizeJsonPayload(payload);
    return { error_code: "SANITIZATION_FAILED", byte_length, shape_hash };
  } catch {
    return {
      error_code: "SANITIZATION_EXCEPTION",
      byte_length,
      shape_hash: "unknown",
    };
  }
}

// Delete directive generation per §11.3
export interface DirectiveInput {
  scope: "conversation" | "account" | "archive";
  account_id?: string;
  conversation_ids?: string[];
  count: number;
}

export function createDeleteDirective(input: DirectiveInput): {
  id: string;
  scope: typeof input.scope;
  account_id?: string;
  conversation_ids?: string[];
  canonical_scope_hash: string;
  count: number;
  created_at: string;
  expires_at: string;
  nonce: string;
} {
  const id = randomBytes(16).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const created_at = new Date().toISOString();
  const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min short-lived

  const canonical = JSON.stringify({
    scope: input.scope,
    account_id: input.account_id ?? null,
    conversation_ids: (input.conversation_ids ?? []).slice().sort(),
    count: input.count,
    nonce,
  });
  const canonical_scope_hash = createHash("sha256").update(canonical).digest("hex");

  return {
    id,
    scope: input.scope,
    account_id: input.account_id,
    conversation_ids: input.conversation_ids,
    canonical_scope_hash,
    count: input.count,
    created_at,
    expires_at,
    nonce,
  };
}

export function verifyDirective(
  directive: { id: string; canonical_scope_hash: string; expires_at: string; used?: boolean; nonce: string; scope: string; account_id?: string; conversation_ids?: string[] },
  args: DirectiveInput
): { valid: boolean; reason?: string } {
  if (directive.used) return { valid: false, reason: "E_CONFIRM_REQUIRED: directive already used (replay)" };
  if (new Date(directive.expires_at).getTime() < Date.now()) return { valid: false, reason: "E_CONFIRM_REQUIRED: expired" };

  const canonical = JSON.stringify({
    scope: args.scope,
    account_id: args.account_id ?? null,
    conversation_ids: (args.conversation_ids ?? []).slice().sort(),
    count: args.count,
    nonce: directive.nonce,
  });
  const hash = createHash("sha256").update(canonical).digest("hex");
  if (hash !== directive.canonical_scope_hash) {
    return { valid: false, reason: "E_CONFIRM_REQUIRED: scope hash mismatch" };
  }
  if (directive.scope !== args.scope) return { valid: false, reason: "E_SCOPE_MISMATCH" };
  return { valid: true };
}

// Account ID stamping authority check
export function assertSupervisorAccountId(supervisorAccountId: string, pageSupplied?: string): void {
  if (pageSupplied && pageSupplied !== supervisorAccountId) {
    // page payload cannot set account_id; supervisor-derived wins, log fuzz attempt
    console.warn(`[security] page-supplied account_id ${pageSupplied} ignored, supervisor ${supervisorAccountId} used`);
  }
}
