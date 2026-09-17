import { createHash } from 'node:crypto';
import type { ProtocolOp, Transport, Direction, EvidenceState } from './Operation.js';

/**
 * Discovery is a permanent product subsystem, not temporary reverse-engineering.
 * Broadly inventory first-party traffic; narrowly retain only payload classes required for archive correctness.
 * Unknown operations stay unknown. Read-only is earned via owner-session probe.
 * RSC/Next.js traffic is first-class.
 */

export class ProtocolCatalog {
  private ops = new Map<string, ProtocolOp>();

  inventory(
    host: string,
    method: string,
    path: string,
    meta: { transport?: Transport; direction?: Direction; payload_family?: string | null; shape?: unknown }
  ): ProtocolOp {
    const hostClass = this.classifyHost(host);
    const pathTemplate = this.maskPath(path);
    const id = this.makeId(hostClass, method, pathTemplate);
    const now = new Date().toISOString();
    const shapeHash = meta.shape ? this.hashShape(meta.shape) : null;

    const existing = this.ops.get(id);
    if (existing) {
      existing.last_seen = now;
      if (shapeHash && existing.shape_hash && shapeHash !== existing.shape_hash) {
        existing.drift_counters['shape_change'] = (existing.drift_counters['shape_change'] ?? 0) + 1;
      }
      if (shapeHash) existing.shape_hash = shapeHash;
      return existing;
    }

    const op: ProtocolOp = {
      id,
      host_class: hostClass,
      method: method.toUpperCase(),
      path_template: pathTemplate,
      transport: meta.transport ?? 'unknown',
      direction: meta.direction ?? 'unknown',
      evidence_state: 'seen',
      account_binding_evidence: 'unknown',
      payload_family: meta.payload_family ?? null,
      shape_hash: shapeHash,
      adapter_id: null,
      adapter_version: null,
      completeness_model: null,
      first_seen: now,
      last_seen: now,
      drift_counters: {},
    };
    this.ops.set(id, op);
    return op;
  }

  classifyHost(host: string): string {
    if (host.includes('arena.ai')) return 'arena_primary';
    if (host.includes('arena')) return 'arena_related';
    if (host.endsWith('.google.com') || host.endsWith('.googleapis.com')) return 'google_auth';
    return 'third_party';
  }

  maskPath(path: string): string {
    return path
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
      .replace(/\/\d{4,}\//g, '/:id/')
      .replace(/\/[A-Za-z0-9_-]{20,}/g, '/:token');
  }

  private makeId(hostClass: string, method: string, pathTemplate: string): string {
    const raw = `${hostClass}:${method.toUpperCase()}:${pathTemplate}`;
    return createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  private hashShape(shape: unknown): string {
    try {
      const json = JSON.stringify(shape, Object.keys(shape as object).sort());
      return createHash('sha256').update(json).digest('hex').slice(0, 16);
    } catch {
      return 'unhashable';
    }
  }

  get(id: string): ProtocolOp | undefined {
    return this.ops.get(id);
  }

  list(): ProtocolOp[] {
    return Array.from(this.ops.values()).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  }

  markVerifiedRead(id: string, adapterId: string, adapterVersion: string): void {
    const op = this.ops.get(id);
    if (!op) return;
    // Read-only is earned — owner-session probe must have established no state change
    op.evidence_state = 'owner_verified_read';
    op.adapter_id = adapterId;
    op.adapter_version = adapterVersion;
    op.account_binding_evidence = 'partition_verified';
  }

  // For diagnostics
  getStats() {
    const byTransport: Record<string, number> = {};
    const byState: Record<string, number> = {};
    for (const op of this.ops.values()) {
      byTransport[op.transport] = (byTransport[op.transport] ?? 0) + 1;
      byState[op.evidence_state] = (byState[op.evidence_state] ?? 0) + 1;
    }
    return { total: this.ops.size, byTransport, byState };
  }
}
