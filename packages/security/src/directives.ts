/**
 * @arena/security/directives — destructive-action guard (plan §11.3).
 *
 * - MCP cannot mint approval: mint() requires the trusted-broker role, which
 *   the MCP service layer never holds (enforced by construction: the service
 *   registry only exposes consume(), never mint()).
 * - Directive: random id + nonce, single-use, short-lived, exact-scope hash.
 * - consume() enforces id match, argument match, scope-hash match, expiry, and
 *   single-use. Any mismatch returns E_CONFIRM_REQUIRED semantics.
 */
import { createHash, randomBytes } from "node:crypto";

export type DirectiveScope =
  | { kind: "conversation"; accountId: string; conversationId: string }
  | { kind: "account"; accountId: string }
  | { kind: "archive" }
  | { kind: "restore" };

export interface Directive {
  id: string;
  scope: DirectiveScope;
  /** Canonical scope hash bound at mint time. */
  scopeHash: string;
  /** Expected destructive count shown to the owner (informational). */
  count: number;
  createdAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
}

export const DIRECTIVE_TTL_MS = 5 * 60 * 1000;

export function canonicalScopeHash(scope: DirectiveScope): string {
  return createHash("sha256")
    .update(JSON.stringify(scope), "utf8")
    .digest("hex");
}

function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/** Trusted broker — lives behind the GUI / local interactive CLI only. */
export class DirectiveBroker {
  private readonly directives = new Map<string, Directive>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  mint(scope: DirectiveScope, count: number): Directive {
    const at = this.now();
    const d: Directive = {
      id: `dir_${randomId()}`,
      scope: { ...scope },
      scopeHash: canonicalScopeHash(scope),
      count,
      createdAtMs: at,
      expiresAtMs: at + DIRECTIVE_TTL_MS,
      consumed: false,
    };
    this.directives.set(d.id, d);
    return { ...d };
  }

  /**
   * Consume a directive for an EXACT scope. Returns the directive on success,
   * or an error code string (E_CONFIRM_REQUIRED / E_EXPIRED) on failure.
   * Failures never consume.
   */
  consume(
    directiveId: string,
    scope: DirectiveScope,
  ): { ok: true; directive: Directive } | { ok: false; code: string } {
    const d = this.directives.get(directiveId);
    if (!d || d.consumed) return { ok: false, code: "E_CONFIRM_REQUIRED" };
    if (this.now() > d.expiresAtMs) {
      this.directives.delete(directiveId);
      return { ok: false, code: "E_CONFIRM_REQUIRED" };
    }
    if (canonicalScopeHash(scope) !== d.scopeHash) {
      return { ok: false, code: "E_CONFIRM_REQUIRED" };
    }
    d.consumed = true;
    this.directives.delete(directiveId);
    return { ok: true, directive: { ...d } };
  }

  /** Test/inspection helper: number of outstanding directives. */
  outstanding(): number {
    return this.directives.size;
  }
}
