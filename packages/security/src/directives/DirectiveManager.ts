import { randomUUID, createHash, randomBytes } from 'node:crypto';

/**
 * Destructive-action guard per section 11.3
 * 1. MCP cannot mint approval.
 * 2. Trusted GUI or local CLI shows exact canonical scope and creates random, single-use, short-lived directive.
 * 3. Directive stores scope IDs + count + canonical scope hash + creation time + nonce.
 * 4. Deletion tool must supply directive ID and matching arguments; mismatch, expiry or replay returns E_CONFIRM_REQUIRED.
 */

export type DirectiveScope = 'conversation' | 'account' | 'archive';

export interface Directive {
  id: string;
  scope: DirectiveScope;
  account_id: string | null;
  conversation_ids: string[];
  count: number;
  canonical_scope_hash: string;
  created_at: string;
  expires_at: string;
  nonce: string;
  used: boolean;
}

export interface CreateDirectiveArgs {
  scope: DirectiveScope;
  account_id?: string | null;
  conversation_ids: string[];
}

export class DirectiveManager {
  private directives = new Map<string, Directive>();

  /**
   * Must be called only from trusted GUI or local interactive CLI.
   * MCP cannot call this directly — enforced at service registry layer.
   */
  createDirective(args: CreateDirectiveArgs, ttlMs = 5 * 60 * 1000): Directive {
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs);
    const canonical = this.canonicalize(args);
    const scopeHash = createHash('sha256').update(canonical).digest('hex');

    const directive: Directive = {
      id: randomUUID(),
      scope: args.scope,
      account_id: args.account_id ?? null,
      conversation_ids: args.conversation_ids.slice().sort(),
      count: args.conversation_ids.length,
      canonical_scope_hash: scopeHash,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      nonce: randomBytes(16).toString('hex'),
      used: false,
    };
    this.directives.set(directive.id, directive);
    return directive;
  }

  verifyDirective(
    directiveId: string,
    args: CreateDirectiveArgs,
  ): { ok: true; directive: Directive } | { ok: false; error: string; code: 'E_CONFIRM_REQUIRED' | 'E_SCOPE_MISMATCH' } {
    const dir = this.directives.get(directiveId);
    if (!dir) {
      return { ok: false, error: 'Directive not found or expired', code: 'E_CONFIRM_REQUIRED' };
    }
    if (dir.used) {
      return { ok: false, error: 'Directive already used (replay)', code: 'E_CONFIRM_REQUIRED' };
    }
    if (new Date(dir.expires_at).getTime() < Date.now()) {
      return { ok: false, error: 'Directive expired', code: 'E_CONFIRM_REQUIRED' };
    }
    const canonical = this.canonicalize(args);
    const scopeHash = createHash('sha256').update(canonical).digest('hex');
    if (scopeHash !== dir.canonical_scope_hash) {
      return { ok: false, error: `Scope hash mismatch: expected ${dir.canonical_scope_hash} got ${scopeHash}`, code: 'E_SCOPE_MISMATCH' };
    }
    if (dir.scope !== args.scope) {
      return { ok: false, error: 'Scope type mismatch', code: 'E_SCOPE_MISMATCH' };
    }
    if ((dir.account_id ?? null) !== (args.account_id ?? null)) {
      return { ok: false, error: 'Account scope mismatch', code: 'E_SCOPE_MISMATCH' };
    }
    // Mark used
    dir.used = true;
    return { ok: true, directive: dir };
  }

  private canonicalize(args: CreateDirectiveArgs): string {
    return JSON.stringify({
      scope: args.scope,
      account_id: args.account_id ?? null,
      conversation_ids: args.conversation_ids.slice().sort(),
      count: args.conversation_ids.length,
    });
  }

  // For persistence layer to store
  list(): Directive[] {
    return Array.from(this.directives.values());
  }

  purgeExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, dir] of this.directives) {
      if (new Date(dir.expires_at).getTime() < now || dir.used) {
        this.directives.delete(id);
        count++;
      }
    }
    return count;
  }
}
