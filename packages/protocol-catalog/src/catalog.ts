import { ArchiveError, canonicalJson, sha256Hex } from '@arena/core';
import type { CompletenessState } from '@arena/schema';

/**
 * Protocol catalog (plan §8): discovery is a permanent subsystem.
 * - Unknown operations stay unknown; nothing is parsed against a guessed schema.
 * - Evidence states only move forward through owner-session qualification.
 * - RSC/Next.js document traffic is first-class (transport 'rsc').
 * - Drift produces structured events tied to the affected adapter.
 */

export type Transport = 'json' | 'chunked' | 'sse' | 'websocket' | 'download' | 'rsc' | 'unknown';
export type Direction = 'read' | 'mutate' | 'asset' | 'auth' | 'config' | 'unknown';
export type EvidenceState = 'seen' | 'classified' | 'adapter_ready' | 'owner_verified_read' | 'deprecated';

export const EVIDENCE_STATE_ORDER: EvidenceState[] = ['seen', 'classified', 'adapter_ready', 'owner_verified_read'];

export interface ObservedRequest {
  host: string;
  method: string;
  url: string;
  resourceType?: string;          // CDP Network.responseReceived type
  mimeType?: string;
  status?: number;
  hasUpgradeWebsocket?: boolean;
  contentType?: string;
}

export interface CatalogOp {
  id: string;
  host_class: HostClass;
  method: string;
  path_template: string;
  transport: Transport;
  direction: Direction;
  evidence_state: EvidenceState;
  account_binding_evidence: string | null;
  payload_family: string | null;
  shape_hash: string | null;
  adapter_id: string | null;
  adapter_version: number;
  completeness_model: CompletenessModel | null;
  first_seen: number;
  last_seen: number;
  drift: DriftCounters;
}

export type CompletenessModel = 'single_json' | 'stream_terminal_event' | 'stream_close_frame' | 'download_finished' | 'document_response' | 'unknown';

export interface DriftCounters {
  shaped: number;
  status: number;
  unknown_fields: number;
  missing_terminal: number;
  ui_network_disagreement: number;
}

export type HostClass = 'arena_first_party' | 'arena_asset_cdn' | 'auth_third_party' | 'other';

const ARENA_HOST_RE = /(^|\.)arena\.ai$/i;

export function hostClass(host: string): HostClass {
  if (ARENA_HOST_RE.test(host)) return 'arena_first_party';
  if (/^cdn\.|assets|static/i.test(host) && /arena/i.test(host)) return 'arena_asset_cdn';
  if (/auth0|cognito|okta|accounts\.|login\./i.test(host)) return 'auth_third_party';
  return 'other';
}

/**
 * Path template with identifier-like segments masked to `:id`.
 * Masking is structural (long hex/numeric/uuid/ulid-ish), never name-list based.
 */
export function toPathTemplate(path: string): string {
  const segs = path.split('/').map((seg) => {
    if (seg === '') return seg;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
    if (/^[0-9]+$/.test(seg)) return ':id';
    if (/^[A-Za-z0-9_-]{18,}$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) return ':id';
    if (/^[a-f0-9]{32,}$/i.test(seg)) return ':id';
    return seg;
  });
  return segs.join('/') || '/';
}

export function inferTransport(req: ObservedRequest, resp?: { contentType?: string; isWebSocket?: boolean; download?: boolean }): Transport {
  if (resp?.isWebSocket) return 'websocket';
  const ct = (resp?.contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) return 'sse';
  if (ct.includes('text/x-component') || ct.includes('flight')) return 'rsc';
  if (resp?.download || ct.includes('octet-stream')) return 'download';
  if (ct.includes('application/json')) return 'json';
  if (req.resourceType === 'Document' || ct.startsWith('text/html')) return 'rsc'; // Next.js document may carry RSC payload
  if (ct.startsWith('text/') || ct.includes('stream')) return 'chunked';
  return 'unknown';
}

/** Direction heuristic is intentionally weak: `read` here means *looks like a read*, not replay-qualified. */
export function inferDirection(req: ObservedRequest): Direction {
  const m = req.method.toUpperCase();
  if (m === 'GET' || m === 'HEAD') {
    if (/\/(login|logout|signin|signout|auth|oauth|mfa|callback)([/?]|$)/i.test(req.url)) return 'auth';
    if (/\.js|\.css|\.png|\.jpg|\.svg|\.woff/i.test(req.url)) return 'asset';
    return 'read';
  }
  if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') return 'mutate';
  return 'unknown';
}

export type DriftKind = 'shape_change' | 'status_change' | 'missing_terminal' | 'unknown_fields' | 'ui_network_disagreement';

export interface DriftEvent {
  id: string;
  op_id: string;
  kind: DriftKind;
  detail: Record<string, unknown>;
  observed_at: number;
}

export class ProtocolCatalog {
  #ops = new Map<string, CatalogOp>();
  #drift: DriftEvent[] = [];
  #seq = 0;

  static opKey(host_class: HostClass, method: string, path_template: string): string {
    return `${host_class}:${method.toUpperCase()}:${path_template}`;
  }

  get operations(): CatalogOp[] { return [...this.#ops.values()].map((o) => ({ ...o, drift: { ...o.drift } })); }
  get driftEvents(): DriftEvent[] { return [...this.#drift]; }

  observe(req: ObservedRequest, resp: { contentType?: string; status?: number; isWebSocket?: boolean; download?: boolean } | undefined, at: number): CatalogOp {
    let u: URL;
    try { u = new URL(req.url); } catch {
      // Unknown stays unknown (§2 rule 1): record it as an unparseable-host op, never throw.
      u = new URL('https://invalid.invalid/');
    }
    const hc = hostClass(u.hostname);
    const tpl = toPathTemplate(u.pathname);
    const key = ProtocolCatalog.opKey(hc, req.method, tpl);
    const transport = inferTransport(req, { ...resp, contentType: resp?.contentType });
    const direction = inferDirection({ ...req, host: u.hostname });
    let op = this.#ops.get(key);
    if (!op) {
      op = {
        id: `op_${++this.#seq}`,
        host_class: hc,
        method: req.method.toUpperCase(),
        path_template: tpl,
        transport,
        direction,
        evidence_state: 'seen',
        account_binding_evidence: null,
        payload_family: null,
        shape_hash: null,
        adapter_id: null,
        adapter_version: 1,
        completeness_model: 'unknown',
        first_seen: at,
        last_seen: at,
        drift: { shaped: 0, status: 0, unknown_fields: 0, missing_terminal: 0, ui_network_disagreement: 0 },
      };
      this.#ops.set(key, op);
    }
    op.last_seen = at;
    if (op.transport === 'unknown' && transport !== 'unknown') op.transport = transport;
    if (resp?.status !== undefined && resp.status !== (op as CatalogOp & { _lastStatus?: number })._lastStatus) {
      (op as CatalogOp & { _lastStatus?: number })._lastStatus = resp.status;
      // status changes vs prior observations are drift once we have a baseline
    }
    return { ...op, drift: { ...op.drift } };
  }

  /**
   * Record a parsed payload shape for an op; returns drift if the shape changed.
   * Unknown fields = keys present that the current adapter doesn't model.
   */
  observeShape(opKeyStr: string, skeletonHash: string, unknownKeys: string[], at: number): DriftEvent | null {
    const op = this.#ops.get(opKeyStr);
    if (!op) throw new ArchiveError('E_NOT_FOUND', 'unknown op for shape observation');
    let event: DriftEvent | null = null;
    if (op.shape_hash !== null && op.shape_hash !== skeletonHash) {
      op.drift.shaped++;
      event = this.#driftEvent(op.id, 'shape_change', { before: op.shape_hash, after: skeletonHash }, at);
    }
    op.shape_hash = skeletonHash;
    if (unknownKeys.length > 0) {
      op.drift.unknown_fields++;
      const e = this.#driftEvent(op.id, 'unknown_fields', { keys: unknownKeys.slice(0, 20), count: unknownKeys.length }, at);
      event ??= e;
    }
    return event;
  }

  observeMissingTerminal(opKeyStr: string, at: number): DriftEvent {
    const op = this.#ops.get(opKeyStr)!;
    op.drift.missing_terminal++;
    return this.#driftEvent(op.id, 'missing_terminal', {}, at);
  }

  observeUiNetworkDisagreement(opKeyStr: string, detail: Record<string, unknown>, at: number): DriftEvent {
    const op = this.#ops.get(opKeyStr)!;
    op.drift.ui_network_disagreement++;
    return this.#driftEvent(op.id, 'ui_network_disagreement', detail, at);
  }

  #driftEvent(opId: string, kind: DriftKind, detail: Record<string, unknown>, at: number): DriftEvent {
    const e = { id: `drift_${++this.#seq}`, op_id: opId, kind, detail, observed_at: at };
    this.#drift.push(e);
    return e;
  }

  /**
   * State transitions are guarded. Notably: `owner_verified_read` requires a
   * probe record (passed here by archive-service after §9.1 completes), and an
   * HTTP verb is NEVER sufficient (§2 rule 6, §8).
   */
  promote(opKeyStr: string, to: EvidenceState, input: { probeId?: string; adapterId?: string; accountBinding?: string; at: number }): void {
    const op = this.#ops.get(opKeyStr);
    if (!op) throw new ArchiveError('E_NOT_FOUND', 'unknown op');
    const from = EVIDENCE_STATE_ORDER.indexOf(op.evidence_state);
    const target = EVIDENCE_STATE_ORDER.indexOf(to);
    if (to === 'deprecated') { op.evidence_state = to; return; }
    if (target === -1 || target <= from) throw new ArchiveError('E_INVALID_ARGS', `illegal transition ${op.evidence_state} -> ${to}`);
    if (target !== from + 1) throw new ArchiveError('E_INVALID_ARGS', 'evidence states advance one step at a time');
    if (to === 'classified') {
      if (op.transport === 'unknown') throw new ArchiveError('E_DRIFT', 'cannot classify with unknown transport');
    }
    if (to === 'adapter_ready') {
      if (!input.adapterId) throw new ArchiveError('E_INVALID_ARGS', 'adapter_ready requires adapter id');
      op.adapter_id = input.adapterId ?? op.adapter_id;
      op.completeness_model = 'stream_terminal_event';
    }
    if (to === 'owner_verified_read') {
      if (!input.probeId) throw new ArchiveError('E_DRIFT', 'owner_verified_read requires a completed read qualification probe (HTTP verb is not enough)');
      if (op.direction !== 'read') throw new ArchiveError('E_SCOPE_MISMATCH', 'only read-direction ops can be owner-verified reads');
      if (!input.accountBinding) throw new ArchiveError('E_SCOPE_MISMATCH', 'owner_verified_read requires account binding evidence');
      op.account_binding_evidence = input.accountBinding;
    }
    op.evidence_state = to;
  }

  /** Ops currently eligible for autonomous history replay (fully qualified, not drifting). */
  replayQualified(): CatalogOp[] {
    return this.operations.filter(
      (op) => op.evidence_state === 'owner_verified_read'
        && op.drift.shaped === 0 && op.drift.unknown_fields === 0 && op.drift.missing_terminal === 0
    );
  }

  /** Drift invalidates qualification until reprobed (§9.1 step 8): demote to adapter_ready. */
  invalidateByDrift(opId: string): void {
    const op = [...this.#ops.values()].find((o) => o.id === opId);
    if (op && op.evidence_state === 'owner_verified_read') op.evidence_state = 'adapter_ready';
  }

  /** Snapshot for persistence (JSON-safe, canonical for hashing). */
  snapshotJson(): string {
    return canonicalJson(this.operations);
  }

  restore(ops: CatalogOp[]): void {
    this.#ops.clear();
    for (const op of ops) this.#ops.set(ProtocolCatalog.opKey(op.host_class, op.method, op.path_template), op);
  }
}

/** Canonical hash of an operation's identity — used as `operation_key`. */
export function operationKey(host_class: HostClass, method: string, path_template: string): string {
  return sha256Hex(ProtocolCatalog.opKey(host_class, method, path_template)).slice(0, 16);
}
