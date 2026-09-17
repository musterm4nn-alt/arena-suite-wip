/**
 * Protocol catalog per §8 — permanent product subsystem
 */

import { ProtocolOp, Transport, Direction, EvidenceState } from "@arena-archive/schema";
import { createHash } from "node:crypto";

export interface DriftEvent {
  id: string;
  op_id: string;
  type: "shape_change" | "missing_terminal" | "unknown_field" | "unexpected_status" | "ui_network_mismatch";
  observed_at: string;
  old_shape_hash?: string;
  new_shape_hash?: string;
  details: any;
  adapter_id: string;
}

export class ProtocolCatalog {
  private ops = new Map<string, ProtocolOp>();
  private driftEvents: DriftEvent[] = [];

  inventoryFromNetworkEvent(ev: { host: string; method: string; path: string; transport: Transport; direction: Direction; payload_family: string; shape_hash: string; adapter_id: string; adapter_version: string }): ProtocolOp {
    const path_template = this.maskIdentifiers(ev.path);
    const id = `${ev.host}:${ev.method}:${path_template}`;

    const existing = this.ops.get(id);
    const now = new Date().toISOString();

    if (existing) {
      // check drift
      if (existing.shape_hash !== ev.shape_hash) {
        this.driftEvents.push({
          id: `drift-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          op_id: id,
          type: "shape_change",
          observed_at: now,
          old_shape_hash: existing.shape_hash,
          new_shape_hash: ev.shape_hash,
          details: { path_template, old: existing.shape_hash, new: ev.shape_hash },
          adapter_id: ev.adapter_id,
        });
        existing.drift_counters["shape_change"] = (existing.drift_counters["shape_change"] || 0) + 1;
      }
      existing.last_seen = now;
      existing.shape_hash = ev.shape_hash; // update to latest, but drift recorded
      return existing;
    }

    const op: ProtocolOp = {
      id,
      host_class: ev.host,
      method: ev.method,
      path_template,
      transport: ev.transport,
      direction: ev.direction,
      evidence_state: "seen",
      payload_family: ev.payload_family,
      shape_hash: ev.shape_hash,
      adapter_id: ev.adapter_id,
      adapter_version: ev.adapter_version,
      first_seen: now,
      last_seen: now,
      drift_counters: {},
    };
    this.ops.set(id, op);
    return op;
  }

  classify(opId: string, evidence_state: EvidenceState, completeness_model?: string) {
    const op = this.ops.get(opId);
    if (!op) return;
    op.evidence_state = evidence_state;
    if (completeness_model) op.completeness_model = completeness_model;
  }

  maskIdentifiers(path: string): string {
    // Mask UUIDs, numeric IDs, hashes
    return path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:uuid")
      .replace(/\/[0-9a-f]{24,}/gi, "/:id")
      .replace(/\/\d{5,}/g, "/:num")
      .replace(/=[^&]+/g, "=:param");
  }

  computeShapeHash(payload: unknown): string {
    const str = JSON.stringify(payload, Object.keys(payload as any ?? {}).sort());
    return createHash("sha256").update(str).digest("hex").slice(0, 16);
  }

  getOps(): ProtocolOp[] {
    return Array.from(this.ops.values());
  }

  getDriftEvents(): DriftEvent[] {
    return this.driftEvents;
  }

  // For P0: broadly inventory first-party traffic; narrowly retain only payload classes required for archive correctness
  isRequiredForArchive(payload_family: string): boolean {
    const required = new Set([
      "arena.chat.stream",
      "arena.chat.create",
      "arena.history.list",
      "arena.history.detail",
      "arena.vote",
      "arena.artifact.download",
      "rsc.flight",
    ]);
    return required.has(payload_family);
  }

  // Fail closed on sanitization: if cannot safely project, persist only error code, byte length, shape hash
  failClosedProjection(payload: unknown, byte_length: number): { error_code: string; byte_length: number; shape_hash: string } {
    return {
      error_code: "PROJECTION_FAILED",
      byte_length,
      shape_hash: this.computeShapeHash(payload),
    };
  }
}
