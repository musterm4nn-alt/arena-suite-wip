import { randomToken, sha256Hex, canonicalJson, ArchiveError, type Clock, systemClock } from '@arena/core';

/**
 * Destructive-action guard (plan §11.3).
 * - MCP can never mint a directive (mint is only callable from the trusted GUI/CLI surface,
 *   and the broker is not exposed through any service registry domain).
 * - Directives are random, single-use, short-lived, bound to canonical scope + hash.
 * - Mismatch, expiry, or replay => E_CONFIRM_REQUIRED.
 */
export interface DirectiveScope {
  scope: 'conversation' | 'account' | 'archive';
  /** Canonical local ids; for `archive` the full account list. */
  ids: string[];
}

interface StoredDirective {
  id: string;
  scope: DirectiveScope['scope'];
  scopeIds: string[];
  itemCount: number;
  scopeHash: string;
  nonceHash: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export class DirectiveBroker {
  #store = new Map<string, StoredDirective>();
  #clock: Clock;
  #ttlMs: number;

  constructor(opts: { clock?: Clock; ttlMs?: number } = {}) {
    this.#clock = opts.clock ?? systemClock;
    this.#ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  }

  /** Trusted surface only: exact canonical scope must be rendered to the owner for confirmation. */
  mint(scope: DirectiveScope): { id: string; exactScopeDescription: string; expiresAt: number } {
    const ids = canonicalScopeIds(scope);
    const nonce = randomToken(16);
    const id = randomToken(16);
    const now = this.#clock.now();
    const scopeHash = sha256Hex(canonicalJson({ scope: scope.scope, ids, nonce }));
    this.#store.set(id, {
      id,
      scope: scope.scope,
      scopeIds: ids,
      itemCount: ids.length,
      scopeHash,
      nonceHash: sha256Hex(nonce),
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      used: false,
    });
    return { id, exactScopeDescription: `${scope.scope}: ${ids.length} item(s) [${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '…' : ''}]`, expiresAt: now + this.#ttlMs };
  }

  /**
   * Deletion tools must present directiveId + exactly matching arguments.
   * Any deviation fails closed with E_CONFIRM_REQUIRED (§11.3 rule 4).
   */
  consume(directiveId: string, claimed: DirectiveScope): StoredDirective {
    const d = this.#store.get(directiveId);
    if (!d) throw new ArchiveError('E_CONFIRM_REQUIRED', 'unknown directive');
    if (d.used) {
      d.used = true; // replay stays consumed
      throw new ArchiveError('E_CONFIRM_REQUIRED', 'directive already used');
    }
    if (this.#clock.now() > d.expiresAt) throw new ArchiveError('E_CONFIRM_REQUIRED', 'directive expired');
    const claimedIds = canonicalScopeIds(claimed);
    const same = claimed.scope === d.scope
      && claimedIds.length === d.scopeIds.length
      && claimedIds.every((x, i) => x === d.scopeIds[i]);
    if (!same) throw new ArchiveError('E_CONFIRM_REQUIRED', 'directive scope mismatch');
    d.used = true;
    return d;
  }

  /** Audit records for durable storage (never the nonce). */
  static auditFields(d: StoredDirective) {
    return { id: d.id, scope: d.scope, scope_ids: JSON.stringify(d.scopeIds), item_count: d.itemCount, scope_hash: d.scopeHash, nonce_hash: d.nonceHash, created_at: d.createdAt, expires_at: d.expiresAt };
  }
}

function canonicalScopeIds(scope: DirectiveScope): string[] {
  return [...new Set(scope.ids)].sort();
}
