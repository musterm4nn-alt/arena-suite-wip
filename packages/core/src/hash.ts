import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
  return h.digest('hex');
}

/** Stable stringification: object keys sorted, arrays ordered. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = canonicalize(v);
  }
  return out;
}

/**
 * Structural skeleton of a JSON value: keys + leaf types only, values erased.
 * Used by the protocol catalog to detect *shape* drift without persisting
 * payload content (§8). Depth-limited; beyond `maxDepth` we collapse to "…".
 */
export function structuralSkeleton(value: unknown, maxDepth = 12): unknown {
  const walk = (v: unknown, d: number): unknown => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return d >= maxDepth ? '[…]' : [collapseTypes(v.map((x) => walk(x, d + 1)))];
    if (typeof v === 'object') {
      if (d >= maxDepth) return '{…}';
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k], d + 1);
      }
      return out;
    }
    return typeof v;
  };
  return walk(value, 0);
}

/** Union of element skeletons so list length does not change the shape hash. */
function collapseTypes(items: unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const it of items) seen.set(canonicalJson(it), it);
  return [...seen.values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

export function shapeHash(value: unknown): string {
  return sha256Hex(canonicalJson(structuralSkeleton(value)));
}
