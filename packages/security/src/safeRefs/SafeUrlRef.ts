import { createHash } from 'node:crypto';

/**
 * Safe reference for sensitive resource URL per 11.2:
 * {host, path, query_key_set, query_hash, expiry_class}
 * Sufficient for correlation but not replay.
 */

export interface SafeUrlRef {
  host: string;
  path: string;
  query_key_set: string[];
  query_hash: string; // hash of full query string, not reversible to token
  expiry_class: 'none' | 'short' | 'long' | 'unknown';
  original_length: number;
}

export function toSafeUrlRef(rawUrl: string): SafeUrlRef | { error: string } {
  try {
    const u = new URL(rawUrl);
    const queryKeys = Array.from(u.searchParams.keys()).sort();
    const queryHash = createHash('sha256').update(u.search).digest('hex').slice(0, 16);

    let expiryClass: SafeUrlRef['expiry_class'] = 'none';
    const exp = u.searchParams.get('expires') || u.searchParams.get('exp') || u.searchParams.get('Expires');
    if (exp) {
      const now = Date.now() / 1000;
      const expNum = parseInt(exp, 10);
      if (!isNaN(expNum)) {
        const delta = expNum - now;
        if (delta < 3600) expiryClass = 'short';
        else if (delta < 86400 * 7) expiryClass = 'long';
        else expiryClass = 'long';
      } else {
        expiryClass = 'unknown';
      }
    } else if (u.searchParams.has('token') || u.searchParams.has('signature')) {
      expiryClass = 'short';
    }

    // Mask identifiers in path: replace UUIDs, long numeric IDs
    const maskedPath = u.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d{6,}\//g, '/:num/');

    return {
      host: u.host,
      path: maskedPath,
      query_key_set: queryKeys,
      query_hash: queryHash,
      expiry_class: expiryClass,
      original_length: rawUrl.length,
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function safeUrlRefToString(ref: SafeUrlRef): string {
  return JSON.stringify(ref);
}
