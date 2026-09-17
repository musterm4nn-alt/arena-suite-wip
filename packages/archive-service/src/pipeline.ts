import { createHash } from 'node:crypto';
import { ArchiveError, canonicalJson, sha256Hex } from '@arena/core';
import { WitnessMessageSchema, RoutedEventSchema, type CompletenessState, type RoutedEvent } from '@arena/schema';
import { sanitizeJsonValue, sanitizeHeaders } from '@arena/security';
import {
  StreamAssembler, CaptureQueue, EventRouter, SseParser, NdjsonParser, WsLedger,
  decideCompleteness, reconcileWireWithWitness, type AssemblyRecord, type SseRecord, type TerminalEvidence,
} from '@arena/capture-core';
import { ProtocolCatalog, operationKey, type HostClass, type ObservedRequest } from '@arena/protocol-catalog';
import type { AdapterEvent } from '@arena/browser-adapter';
import { ArchiveStore } from './store.ts';

/**
 * Capture pipeline: adapter events -> routed events -> observation journal ->
 * assembled streams -> normalized turns. This is the same code path the
 * production app runs; only the adapter differs (mock here, Electron there).
 */

export interface PipelineDeps {
  store: ArchiveStore;
  catalog: ProtocolCatalog;
  queue: CaptureQueue;
  router: EventRouter;
  maxStreamBytes: number;
}

interface PendingStream {
  requestId: string;
  accountId: string;
  epochId: string | null;
  url: string;
  method: string;
  contentType: string;
  expectedBytes: number | null;
  textParts: Array<{ kind: string; text: string }>;
  sawDelta: boolean;
  convRef: string | null;
  modelLabels: Map<number, { blind?: string; selected?: string; displayed?: string; revealed?: string }>;
  gapNotes: string[];
  mode: 'battle' | 'direct' | 'side_by_side' | null;
  revealed: Map<number, string>;
  selected: Map<number, string>;
  sse?: SseParser;
  ndjson?: NdjsonParser;
  uiWitness?: unknown;
  userAbort: boolean;
}

export class CapturePipeline {
  #assembler: StreamAssembler;
  #pending = new Map<string, PendingStream>();
  #ws = new Map<string, { ledger: WsLedger; accountId: string; url: string }>();
  #deps: PipelineDeps;
  #unsub: (() => void) | null = null;
  completedTurns = 0;
  gaps = 0;

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
    this.#assembler = new StreamAssembler({ maxAssembledBytes: deps.maxStreamBytes });
    deps.queue.onGap(({ lostCount }) => {
      this.gaps += lostCount;
      for (const rid of this.#assembler.activeRequestIds()) this.#assembler.note(rid, 'overflow_gap');
    });
  }

  /** Attach an adapter's event stream for a bound account view. */
  attachAdapter(view: { onEvent(cb: (e: AdapterEvent) => void): () => void; accountId: string }, epochId: string | null): () => void {
    const off = view.onEvent((e) => { void this.ingest(e, view.accountId, epochId); });
    this.#unsub = off;
    return off;
  }

  async ingest(e: AdapterEvent, accountId: string, epochId: string | null): Promise<void> {
    const { router, queue } = this.#deps;
    if (e.type === 'diagnostic' || e.type === 'protocol_step') return; // handled by supervisor
    if (e.type === 'renderer_gone') {
      this.#forceCloseAllForAccount(accountId, 'renderer_gone');
      return;
    }
    if (e.type === 'target_attached') {
      if (e.parentTargetId && e.sessionId && e.targetId) {
        router.bindChild(e.sessionId, e.targetId, e.parentTargetId, e.targetKind ?? 'other');
      } else if (e.sessionId && e.targetId) {
        router.bind(e.sessionId, e.targetId, { account_id: accountId, session_epoch_id: epochId ?? 'unknown', kind: 'page' });
      }
      const routed = router.route(
        { mechanism: 'cdp_target', kind: 'target_info', observed_at: Date.now(), payload: { targetKind: e.targetKind ?? 'page', parent: e.parentTargetId ?? null } },
        { sessionId: e.sessionId, targetId: e.targetId }
      );
      if (routed) queue.push(routed.event);
      return;
    }
    if (e.type === 'download' && e.download) {
      queue.push({
        account_id: accountId, session_epoch_id: epochId ?? undefined, mechanism: 'download', kind: 'download',
        observed_at: Date.now(), payload: { url: e.download.url, filename: e.download.suggestedFilename, contentLength: e.download.contentLength ?? null },
        completeness: 'imported',
      });
      return;
    }
    if (e.type === 'cdp' && e.cdp) {
      const cdp = e.cdp;
      const p = cdp.params ?? {};
      const at = Date.now();
      switch (cdp.method) {
        case 'Network.requestWillBeSent': {
          const rid = String(p.requestId);
          const req = (p.request ?? {}) as { url?: string; method?: string; headers?: Record<string, unknown> };
          const routed = router.route({ mechanism: 'cdp_network', kind: 'request', observed_at: at, request_id: rid, payload: { url: req.url, method: req.method, headers: sanitizeHeaders(req.headers ?? {}).kept } }, { sessionId: cdp.sessionId });
          const payload = { url: req.url ?? '', method: (req.method ?? 'GET').toUpperCase(), headers: req.headers };
          let opKey: string;
          try {
            const op = this.#deps.catalog.observe(
              { host: safeHost(req.url ?? ''), method: (req.method ?? 'GET'), url: req.url ?? '', resourceType: p.type as string | undefined },
              undefined, at
            );
            opKey = operationKey(op.host_class as HostClass, op.method, op.path_template);
          } catch {
            opKey = 'unclassifiable';
          }
          const ev: RoutedEvent = { ...(routed?.event ?? { mechanism: 'cdp_network', kind: 'request', observed_at: at, account_id: accountId, completeness: 'unknown' as CompletenessState }), request_id: rid, operation_key: opKey };
          queue.push(ev);
          this.#beginStream(rid, accountId, epochId, payload.url, payload.method, payload.headers as never);
          break;
        }
        case 'Network.responseReceived': {
          const rid = String(p.requestId);
          const resp = (p.response ?? {}) as { status?: number; headers?: Record<string, string>; mimeType?: string };
          const ct = (resp.headers?.['content-type'] ?? resp.mimeType ?? '').toLowerCase();
          const pend = this.#pending.get(rid);
          if (pend) pend.contentType = ct;
          const cl = resp.headers?.['content-length'];
          if (pend && cl && /^\d+$/.test(cl)) pend.expectedBytes = Number(cl);
          try {
            this.#deps.catalog.observe(
              { host: safeHost(pend?.url ?? ''), method: pend?.method ?? 'GET', url: pend?.url ?? '' },
              { contentType: ct, status: resp.status }, at
            );
          } catch { /* classification is best-effort; capture continues */ }
          queue.push({
            account_id: accountId, session_epoch_id: epochId ?? undefined, mechanism: 'cdp_network', kind: 'response_head',
            observed_at: at, request_id: rid, payload: { status: resp.status ?? null, headers: sanitizeHeaders(resp.headers ?? {}).kept, contentType: ct || null }, completeness: 'unknown',
          });
          break;
        }
        case 'Network.dataReceived': {
          const rid = String(p.requestId);
          const dataB64 = typeof p.data === 'string' ? p.data : '';
          const bytes = dataB64 ? new Uint8Array(Buffer.from(dataB64, 'base64')) : new Uint8Array(0);
          const seq = Number((p as { timestamp?: number }).timestamp ?? this.#assembler.snapshot(rid)?.chunkCount ?? 0);
          const kind = this.#assembler.appendChunk(rid, { seq: Number.isFinite(seq) ? Math.trunc(seq) : 0, bytes, at }, { accountId });
          const pend = this.#pending.get(rid);
          const txt = Buffer.from(bytes).toString('utf8');
          if (pend && kind === 'appended') {
            // raw-byte transports feed their logical parsers directly
            if (pend.contentType.includes('application/x-ndjson') || pend.contentType.includes('json')) pend.ndjson?.pushText(txt);
            if (pend.contentType.includes('text/event-stream')) pend.sse?.push(txt);
          }
          break;
        }
        case 'Network.eventSourceMessageReceived': {
          const rid = String(p.requestId);
          const data = String(p.data ?? '');
          const pend = this.#pending.get(rid);
          if (!pend) break;
          // CDP hands us the *parsed* record: bytes go to the ledger; the logical
          // record is constructed directly (raw-line parsing is only for byte streams).
          const bytes = new Uint8Array(Buffer.from(`data: ${data}\n\n`, 'utf8'));
          this.#assembler.appendChunk(rid, { seq: this.#assembler.snapshot(rid)?.chunkCount ?? 0, bytes, at }, { accountId });
          this.#onLogicalRecord(pend, {
            event: String((p as { eventName?: unknown }).eventName ?? 'message'),
            data,
            id: (p as { lastEventId?: unknown }).lastEventId !== undefined ? String((p as { lastEventId?: unknown }).lastEventId) : null,
            retry: null,
            isDone: data.trim() === '[DONE]',
          });
          break;
        }
        case 'Network.loadingFinished':
        case 'Network.loadingFailed': {
          await this.#closeStream(String(p.requestId), cdp.method === 'Network.loadingFinished', p, accountId, epochId);
          break;
        }
        case 'Network.webSocketCreated': {
          this.#ws.set(String(p.requestId), { ledger: new WsLedger(), accountId, url: String(p.url ?? '') });
          break;
        }
        case 'Network.webSocketFrameReceived': {
          const ws = this.#ws.get(String(p.requestId));
          const resp = (p.response ?? {}) as { payloadData?: string; mask?: boolean; opcode?: number };
          if (ws) ws.ledger.note({ at, payload: String(resp.payloadData ?? ''), isText: resp.opcode === 1 });
          break;
        }
        case 'Network.webSocketClosed': {
          const ws = this.#ws.get(String(p.requestId));
          if (ws) {
            ws.ledger.markClosed();
            const s = ws.ledger.summary();
            this.#deps.store.recordObservation({ account_id: accountId, session_epoch_id: epochId ?? undefined, mechanism: 'cdp_websocket', kind: 'stream_end', request_id: String(p.requestId), observed_at: at, payload: { transport: 'websocket', ...s }, completeness: s.closed ? 'complete' : 'partial_stream' });
            this.completedTurns++;
            this.#ws.delete(String(p.requestId));
          }
          break;
        }
        case 'Network.webSocketFrameError': {
          const ws = this.#ws.get(String(p.requestId));
          if (ws) {
            ws.ledger.markError();
            const s = ws.ledger.summary();
            this.#deps.store.recordObservation({ account_id: accountId, session_epoch_id: epochId ?? undefined, mechanism: 'cdp_websocket', kind: 'stream_end', request_id: String(p.requestId), observed_at: at, payload: { transport: 'websocket', ...s, error: String(p.errorMessage ?? '') }, completeness: 'failed_transport' });
            this.#ws.delete(String(p.requestId));
          }
          break;
        }
        case 'Page.frameNavigated': {
          const frame = (p as { frame?: { id?: string; url?: string } }).frame ?? {};
          const navUrl = (frame.url ?? '').split('?')[0] ?? '';
          const routed = router.route({ mechanism: 'cdp_target', kind: 'target_info', observed_at: at, payload: { event: 'frame_navigated', frame_id: frame.id ?? null, url: (frame.url ?? '').split('?')[0] } }, { sessionId: cdp.sessionId });
          if (routed) queue.push(routed.event);
          // Navigation away interrupts in-flight streams on that document: treat as
          // transport interruption so they end as partial/failed, never dangling.
          if (navUrl.startsWith('https://arena.ai/')) {
            for (const rid of [...this.#pending.keys()]) {
              const pend = this.#pending.get(rid)!;
              if (pend.accountId !== accountId) continue;
              this.#assembler.abandon(rid, at, 'navigated_away');
              await this.#closeStream(rid, false, { contextLoss: 'navigated_away' }, accountId, pend.epochId);
            }
          }
          break;
        }
        case 'Runtime.bindingCalled': {
          const name = String(p.name ?? '');
          if (name !== '__ARENA_ARCHIVE__') break;
          let msg: unknown = null;
          try { msg = JSON.parse(String(p.payload ?? '')); } catch { msg = null; }
          const parsed = msg === null ? null : WitnessMessageSchema.safeParse(msg);
          const routed = router.route({ mechanism: 'ui_witness', kind: 'ui_state', observed_at: at, payload: parsed?.success ? parsed.data : { droppedUnsafe: true }, note: parsed ? undefined : 'witness_parse_failed' }, { sessionId: cdp.sessionId });
          if (routed) this.#deps.queue.push(routed.event);
          break;
        }
        default:
          break;
      }
      return;
    }
  }

  /** Consume queued routed events: journal-first persistence (same txn where possible). */
  drainQueue(): number {
    const evs = this.#deps.queue.drain(512);
    let n = 0;
    for (const ev of evs) {
      const parsed = RoutedEventSchema.safeParse(ev);
      const e = parsed.success ? parsed.data : { ...ev, completeness: ev.completeness ?? 'unknown', account_id: ev.account_id, mechanism: ev.mechanism, kind: ev.kind, observed_at: ev.observed_at } as RoutedEvent;
      const proj = sanitizeJsonValue(e.payload ?? null);
      this.#deps.store.recordObservation(e, proj.ok
        ? { payload_shape_hash: undefined }
        : { payload_bytes: proj.byteLength, payload_shape_hash: proj.shapeHash, sanitize_error: proj.errorCode });
      n++;
    }
    return n;
  }

  #beginStream(rid: string, accountId: string, epochId: string | null, url: string, method: string, _headers: Record<string, unknown>): void {
    if (this.#pending.has(rid)) return;
    const pend: PendingStream = {
      requestId: rid, accountId, epochId, url, method, contentType: '', expectedBytes: null,
      textParts: [], sawDelta: false, convRef: null, modelLabels: new Map(), gapNotes: [], userAbort: false,
      mode: null, revealed: new Map(), selected: new Map(),
    };
    pend.sse = new SseParser((r) => this.#onLogicalRecord(pend, r));
    pend.ndjson = new NdjsonParser((rec) => { if (rec.ok) this.#onLogicalObject(pend, rec.value); });
    this.#pending.set(rid, pend);
    this.#assembler.begin(rid, { accountId });
  }

  #onLogicalRecord(pend: PendingStream, r: SseRecord): void {
    if (r.isDone) { this.#assembler.parserDone(pend.requestId); return; }
    let obj: unknown = null;
    try { obj = JSON.parse(r.data); } catch { obj = null; }
    if (obj !== null) this.#onLogicalObject(pend, obj);
  }

  #onLogicalObject(pend: PendingStream, obj: unknown): void {
    if (obj && typeof obj === 'object') {
      const o = obj as Record<string, unknown>;
      if (o.t === 'meta' || o.type === 'start') {
        if (typeof o.conv === 'string') pend.convRef = o.conv;
        if (o.mode === 'battle' || o.mode === 'direct' || o.mode === 'side_by_side') pend.mode = o.mode;
        if (typeof o.selected === 'string') pend.selected.set(0, o.selected);
        if (typeof o.model === 'string' || typeof o.selected === 'string') {
          pend.modelLabels.set(0, { selected: typeof o.model === 'string' ? o.model : undefined, displayed: typeof o.selected === 'string' ? o.selected : undefined });
        }
        if (o.participants && Array.isArray(o.participants)) {
          (o.participants as Array<Record<string, unknown>>).forEach((p, i) => {
            pend.modelLabels.set(p.position !== undefined ? Number(p.position) : i, {
              blind: p.blind_label ? String(p.blind_label) : undefined,
              displayed: p.displayed_name ? String(p.displayed_name) : undefined,
            });
          });
        }
        return;
      }
      if (o.t === 'vote' && o.revealed && typeof o.revealed === 'object') {
        for (const [pos, name] of Object.entries(o.revealed as Record<string, unknown>)) {
          pend.revealed.set(Number(pos), String(name));
        }
        if (typeof o.selected_position === 'number') pend.selected.set(0, 'position:' + o.selected_position);
        return;
      }
      if ((o.t === 'delta' || o.type === 'delta') && typeof o.text === 'string') {
        pend.sawDelta = true;
        pend.textParts.push({ kind: 'text', text: o.text });
        return;
      }
      if ((o.t === 'reasoning' || o.type === 'reasoning') && typeof o.text === 'string') {
        pend.textParts.push({ kind: 'reasoning', text: o.text });
        return;
      }
    }
  }

  /** Renderer loss: in-flight streams lose context; content stays, terminal is absent. */
  #forceCloseAllForAccount(accountId: string, reason: string): void {
    for (const rid of [...this.#pending.keys()]) {
      const pend = this.#pending.get(rid)!;
      if (pend.accountId !== accountId) continue;
      this.#assembler.abandon(rid, Date.now(), reason);
      void this.#closeStream(rid, false, { contextLoss: reason }, accountId, pend.epochId);
    }
  }

  /**
   * Explicit dangling-close for scenarios/shutdown: content without a terminal
   * becomes partial_stream; nothing captured becomes observer_gap. Never leaves
   * assemblies dangling silently.
   */
  closeOpenStreams(reason = 'observer_context_end'): number {
    let n = 0;
    for (const rid of [...this.#pending.keys()]) {
      const pend = this.#pending.get(rid)!;
      this.#assembler.abandon(rid, Date.now(), reason);
      void this.#closeStream(rid, false, { contextLoss: reason }, pend.accountId, pend.epochId);
      n++;
    }
    return n;
  }

  async #closeStream(rid: string, ok: boolean, params: Record<string, unknown>, accountId: string, epochId: string | null): Promise<void> {
    const pend = this.#pending.get(rid);
    const at = Date.now();
    if (!pend) return;
    this.#pending.delete(rid);
    if (params.canceled === true) pend.userAbort = true;
    const contextLoss = typeof params.contextLoss === 'string' ? params.contextLoss : null;
    if (ok) this.#assembler.transportFinished(rid, at);
    else if (!contextLoss) this.#assembler.transportFailed(rid, at, String(params.errorText ?? 'transport_failed'));
    if (pend.ndjson) {
      const fin = pend.ndjson.finish();
      if (fin.sawDone) this.#assembler.parserDone(rid);
    }
    const { record, text } = this.#assembler.finalize(rid);
    const evidence: TerminalEvidence = {
      transportFinished: record.transportTerminal === 'finished',
      transportFailed: record.transportTerminal === 'failed' ? { reason: record.transportError ?? 'failed' } : undefined,
      parserTerminal: record.parserTerminal === 'done' || (pend.sawDelta && record.transportTerminal === 'finished'),
      userAbortEvidence: pend.userAbort,
      contentPresent: record.assembledBytes > 0,
      contextLoss: contextLoss ? { reason: contextLoss } : undefined,
      observerGap: (record.gapIntervals.length ? [{ reason: 'chunk_gap' }] : []).concat(
        this.gaps > 0 && record.gapCount > 0 ? [{ reason: 'queue_overflow' }] : []
      ),
    };
    const completeness = decideCompleteness(evidence);

    // conversation & branch identity: external ref only when observed
    const convId = this.#deps.store.upsertConversation({
      accountId, externalRef: pend.convRef, source: 'live',
      mode: pend.mode ?? 'unknown', observedAt: at,
    });
    const branchId = this.#deps.store.ensureBranch(convId, 'initial');
    const seq = this.#nextSeq(branchId);
    const turnId = this.#deps.store.insertTurn({
      branchId, seq, role: 'assistant', completeness,
      terminalEvidence: {
        transportTerminal: record.transportTerminal, parserTerminal: record.parserTerminal,
        assembledBytes: record.assembledBytes, expectedBytes: record.expectedBytes,
        gaps: record.gapIntervals.length, duplicates: record.duplicateCount, userAbort: pend.userAbort,
      },
      streamStats: this.#assemblyLedger(record, text),
      startedAt: record.startedAt ?? at, endedAt: record.endedAt ?? at,
    });

    const obsIds: number[] = [];
    const streamEndObs = this.#deps.store.recordObservation({
      account_id: accountId, session_epoch_id: epochId ?? undefined, mechanism: 'cdp_network', kind: 'stream_end', request_id: rid, observed_at: at,
      payload: { completeness, body_sha256: record.bodySha256, assembledBytes: record.assembledBytes }, completeness,
    });
    obsIds.push(streamEndObs);
    // Link the journal's request observation as provenance for the whole turn (bounded, no scan).
    const reqRow = this.#deps.store.db.prepare('SELECT id FROM observation WHERE account_id=? AND request_id=? AND kind=? ORDER BY id LIMIT 1')
      .get(accountId, rid, 'request') as { id: number } | undefined;
    if (reqRow) obsIds.push(Number(reqRow.id));

    // parts from logical records when parseable; otherwise the whole assembled body as one part
    const parts: Array<{ kind: string; content: unknown }> = [];
    if (pend.textParts.length > 0) {
      parts.push(...mergeParts(pend.textParts).map((mp) => ({ kind: mp.kind, content: { text: mp.text } })));
    } else if (record.assembledBytes > 0) {
      parts.push({ kind: looksJsonLike(pend.contentType) ? 'text' : 'unknown', content: { raw: true, text, sha256: record.bodySha256 } });
    }
    for (let i = 0; i < parts.length; i++) {
      this.#deps.store.insertPart(turnId, i, parts[i]!.kind, parts[i]!.content, obsIds);
    }

    // identity: labels are *claims*, scoped and append-only
    for (const [pos, labels] of pend.modelLabels) {
      const pid = this.#deps.store.ensureParticipant(convId, pos);
      if (labels.blind) this.#deps.store.addIdentityClaim({ participantId: pid, type: 'blind_label', value: labels.blind, observationId: streamEndObs });
      if (labels.selected) this.#deps.store.addIdentityClaim({ participantId: pid, type: 'selected_label', value: labels.selected, observationId: streamEndObs });
      if (labels.displayed) this.#deps.store.addIdentityClaim({ participantId: pid, type: 'displayed_name', value: labels.displayed, observationId: streamEndObs });
    }
    // late reveal evidence: appended, never overwriting the earlier claims (§10.1)
    for (const [pos, name] of pend.revealed) {
      const pid = this.#deps.store.ensureParticipant(convId, pos);
      this.#deps.store.addIdentityClaim({ participantId: pid, type: 'post_vote_reveal', value: name, observationId: streamEndObs });
    }

    if (completeness === 'complete') this.completedTurns++;
    if (completeness === 'observer_gap' || record.gapIntervals.length > 0) this.gaps++;
  }

  #nextSeq(branchId: string): number {
    const row = this.#deps.store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM turn WHERE branch_id=?').get(branchId) as { n: number };
    return Number(row.n);
  }

  #assemblyLedger(record: AssemblyRecord, text: string): Record<string, unknown> {
    return {
      requestId: record.requestId,
      chunkCount: record.chunkCount,
      duplicateCount: record.duplicateCount,
      gapCount: record.gapCount,
      receivedBytes: record.receivedBytes,
      assembledBytes: record.assembledBytes,
      expectedBytes: record.expectedBytes,
      bodySha256: record.bodySha256,
      textSha256: sha256Hex(text),
      firstSeq: record.firstSeq, lastSeq: record.lastSeq,
      transportTerminal: record.transportTerminal,
      parserTerminal: record.parserTerminal,
    };
  }

  lastWitnessForUI: { message: import('@arena/schema').WitnessMessage; renderedText: string } | null = null;

  private stripQuery(u: string): string { const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

  /** Reconcile a completed turn's wire evidence against the latest UI witness (P2). */
  reconcile(turnId: string): { agreement: string } {
    const t = this.#deps.store.getTurn(turnId);
    if (!t) throw new ArchiveError('E_NOT_FOUND', 'turn');
    const textPart = t.parts.at(-1);
    const wireText = textPart ? String((JSON.parse(String(textPart.content_json)) as { text?: string }).text ?? '') : '';
    const wire = {
      assembledTextDigest: createHash('sha256').update(wireText).digest('hex'),
      partCount: t.parts.length, order: t.parts.map((x) => String(x.id)), terminal: t.turn.completeness === 'complete',
      participantLabels: [],
    };
    if (!this.lastWitnessForUI) return { agreement: 'no_witness' };
    const r = reconcileWireWithWitness(wire, this.lastWitnessForUI);
    if (r.agreement === 'conflict') {
      const acct = this.#deps.store.db.prepare(`SELECT c.account_id AS a FROM turn t JOIN branch b ON b.id=t.branch_id JOIN conversation c ON c.id=b.conversation_id WHERE t.id=?`).get(turnId) as { a?: string } | undefined;
      this.#deps.store.recordConflict(acct?.a ?? 'unbound', r.kind, { ...r.detail, turn_id: turnId });
    }
    return { agreement: r.agreement };
  }

  setWitness(w: { message: import('@arena/schema').WitnessMessage; renderedText: string } | null): void { this.lastWitnessForUI = w; }

  snapshot(): { completedTurns: number; gaps: number; queue: import('@arena/capture-core').QueueMetrics; active: string[] } {
    return {
      completedTurns: this.completedTurns, gaps: this.gaps, queue: this.#deps.queue.metrics,
      active: this.#assembler.activeRequestIds(),
    };
  }
}

function mergeParts(parts: Array<{ kind: string; text: string }>): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last && last.kind === p.kind) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

function looksJsonLike(ct: string): boolean {
  return ct.includes('json') || ct.includes('event-stream') || ct.includes('ndjson');
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'invalid'; }
}

export { canonicalJson };
