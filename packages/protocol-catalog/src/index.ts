/**
 * @arena/protocol-catalog — operation inventory + drift (plan §8).
 *
 * Discovery is permanent: broadly inventory first-party traffic, narrowly
 * retain only payload classes required for archive correctness. Unknown
 * operations stay unknown; read-only is earned via owner-session probes
 * (see @arena/sync), never inferred from the HTTP verb.
 */
import { randomUUID } from "node:crypto";
import type {
  EvidenceState,
  ProtocolDirection,
  ProtocolOp,
  Transport,
} from "@arena/schema";
import { shapeHashOfJson } from "@arena/security";

export interface ObservedRequest {
  host: string;
  method: string;
  path: string;
  transport: Transport;
  /** Sanitized sample (structure only is enough for classification). */
  sampleShape?: unknown;
  observedAtMs: number;
}

export interface DriftEvent {
  id: string;
  opId: string;
  kind:
    | "shape-changed"
    | "terminal-missing"
    | "unknown-fields"
    | "status-anomaly"
    | "ui-network-disagreement";
  detail: string;
  atMs: number;
}

/** Mask path identifiers: UUIDs, long alnum runs, pure numbers -> :id. */
export function maskPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg.length === 0) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
        return ":id";
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[A-Za-z0-9_-]{16,}$/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

export function hostClass(host: string): string {
  const h = host.toLowerCase();
  if (h === "arena.ai" || h.endsWith(".arena.ai")) return "first-party";
  return "third-party";
}

export function operationKey(method: string, pathTemplate: string): string {
  return `${method.toUpperCase()} ${pathTemplate}`;
}

export class ProtocolCatalog {
  private readonly ops = new Map<string, ProtocolOp>(); // key -> op
  private readonly drift: DriftEvent[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Inventory one observation. Creates `seen` ops; classifies nothing automatically. */
  observe(req: ObservedRequest): ProtocolOp {
    const template = maskPath(req.path);
    const key = operationKey(req.method, template);
    const existing = this.ops.get(key);
    if (existing) {
      existing.last_seen_ms = req.observedAtMs;
      if (req.sampleShape !== undefined) {
        const shape = shapeHashOfJson(req.sampleShape);
        if (existing.shape_hash !== null && existing.shape_hash !== shape) {
          this.recordDrift(existing, "shape-changed", `shape ${existing.shape_hash.slice(0, 12)} -> ${shape.slice(0, 12)}`);
          existing.shape_hash = shape;
        } else if (existing.shape_hash === null) {
          existing.shape_hash = shape;
        }
      }
      return { ...existing };
    }
    const op: ProtocolOp = {
      id: randomUUID(),
      host_class: hostClass(req.host),
      method: req.method.toUpperCase(),
      path_template: template,
      transport: req.transport,
      direction: "unknown",
      evidence_state: "seen",
      account_binding_evidence: null,
      payload_family: null,
      shape_hash: req.sampleShape !== undefined ? shapeHashOfJson(req.sampleShape) : null,
      adapter_id: null,
      adapter_version: null,
      completeness_model: null,
      first_seen_ms: req.observedAtMs,
      last_seen_ms: req.observedAtMs,
      drift_counters: {},
    };
    this.ops.set(key, op);
    return { ...op };
  }

  /** Narrow classification step — explicit, reviewed, never guessed. */
  classify(
    method: string,
    path: string,
    update: Partial<
      Pick<
        ProtocolOp,
        | "direction"
        | "evidence_state"
        | "payload_family"
        | "adapter_id"
        | "adapter_version"
        | "completeness_model"
        | "account_binding_evidence"
      >
    >,
  ): ProtocolOp | null {
    const op = this.ops.get(operationKey(method, maskPath(path)));
    if (!op) return null;
    // Guard: owner_verified_read can only be set through the sync probe path.
    // This method refuses to set it directly — the probe calls markOwnerVerifiedRead.
    if (update.evidence_state === "owner_verified_read") {
      throw new Error("use markOwnerVerifiedRead() after a successful read probe");
    }
    Object.assign(op, update);
    return { ...op };
  }

  /** Called ONLY by the read-qualification probe after equivalence is established. */
  markOwnerVerifiedRead(method: string, path: string, probeId: string): ProtocolOp | null {
    const op = this.ops.get(operationKey(method, maskPath(path)));
    if (!op) return null;
    op.evidence_state = "owner_verified_read";
    op.direction = "read";
    op.account_binding_evidence = `probe:${probeId}`;
    return { ...op };
  }

  recordDrift(
    op: Pick<ProtocolOp, "id">,
    kind: DriftEvent["kind"],
    detail: string,
  ): DriftEvent {
    const evt: DriftEvent = {
      id: randomUUID(),
      opId: op.id,
      kind,
      detail,
      atMs: this.now(),
    };
    this.drift.push(evt);
    const full = [...this.ops.values()].find((o) => o.id === op.id);
    if (full) {
      full.drift_counters[kind] = (full.drift_counters[kind] ?? 0) + 1;
      // Any drift invalidates read qualification until reprobed (plan §9.1.8).
      if (full.evidence_state === "owner_verified_read") {
        full.evidence_state = "adapter_ready";
      }
    }
    return evt;
  }

  get(method: string, path: string): ProtocolOp | null {
    const op = this.ops.get(operationKey(method, maskPath(path)));
    return op ? { ...op } : null;
  }

  list(): ProtocolOp[] {
    return [...this.ops.values()].map((o) => ({ ...o }));
  }

  driftEvents(): DriftEvent[] {
    return [...this.drift];
  }

  size(): number {
    return this.ops.size;
  }
}

export type { EvidenceState, ProtocolDirection, Transport };
