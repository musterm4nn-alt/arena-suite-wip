import { ArchiveError, canonicalJson, newId, sha256Hex } from '@arena/core';
import type { CompletenessState, DbHandle, RoutedEvent, Row } from '@arena/schema';
import { scanForSecrets } from '@arena/security';

/**
 * Archive store: the ONLY writer. Journal-first — an observation row is the
 * first durable write for anything observed; normalization runs in the same or
 * a later bounded transaction (§10.3).
 */
export class ArchiveStore {
  #db: DbHandle;
  constructor(db: DbHandle) { this.#db = db; }

  get db(): DbHandle { return this.#db; }

  // ---- accounts / epochs ----
  createAccount(label: string, storagePath: string): string {
    const id = newId('acct');
    this.#db.transaction(() => {
      this.#db.prepare('INSERT INTO account (account_id, label, created_at) VALUES (?,?,?)').run(id, label, Date.now());
      this.#db.prepare('INSERT INTO partition_dir (account_id, storage_path, created_at) VALUES (?,?,?)').run(id, storagePath, Date.now());
    });
    return id;
  }
  listAccounts(): Row[] {
    return this.#db.prepare('SELECT account_id, label, enabled, created_at FROM account ORDER BY created_at').all();
  }
  setAccountEnabled(accountId: string, enabled: boolean): void {
    const r = this.#db.prepare('UPDATE account SET enabled=? WHERE account_id=?').run(enabled, accountId);
    if (Number(r.changes) === 0) throw new ArchiveError('E_NOT_FOUND', 'no such account');
  }
  beginEpoch(accountId: string): string {
    const id = newId('epoch');
    this.#db.prepare('INSERT INTO session_epoch (id, account_id, started_at, status) VALUES (?,?,?,?)')
      .run(id, accountId, Date.now(), 'active');
    return id;
  }
  activeEpoch(accountId: string): { id: string } | undefined {
    return this.#db.prepare(`SELECT id FROM session_epoch WHERE account_id=? AND status='active' ORDER BY started_at DESC LIMIT 1`).get(accountId) as { id: string } | undefined;
  }
  endEpoch(epochId: string, status: 'ended' | 'challenged' = 'ended'): void {
    this.#db.prepare('UPDATE session_epoch SET ended_at=?, status=? WHERE id=?').run(Date.now(), status, epochId);
  }
  markChallenged(epochId: string): void {
    this.#db.prepare(`UPDATE session_epoch SET status='challenged' WHERE id=?`).run(epochId);
  }

  // ---- observation journal ----
  recordObservation(ev: RoutedEvent, extra?: { payload_bytes?: number; payload_shape_hash?: string; sanitize_error?: string; artifact_id?: string }): number {
    return this.#db.transaction(() => this.#recordObservationTx(ev, extra));
  }

  #recordObservationTx(ev: RoutedEvent, extra?: { payload_bytes?: number; payload_shape_hash?: string; sanitize_error?: string; artifact_id?: string }): number {
    const payloadJson = ev.payload === undefined ? null : canonicalJson(ev.payload);
    if (payloadJson && process.env.ARENA_CANARY_STRICT === '1') {
      const found = scanForSecrets(payloadJson);
      if (found.length > 0) throw new ArchiveError('E_INTERNAL', `canary detected in durable payload: ${found.join(',')}`);
    }
    const r = this.#db.prepare(`INSERT INTO observation
      (account_id, session_epoch_id, mechanism, operation_key, target_id, cdp_session_id, request_id, observed_at, kind, completeness, payload_json, payload_bytes, payload_shape_hash, sanitize_error, artifact_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      ev.account_id, ev.session_epoch_id ?? null, ev.mechanism, ev.operation_key ?? null,
      ev.target_id ?? null, ev.cdp_session_id ?? null, ev.request_id ?? null,
      ev.observed_at, ev.kind, ev.completeness, payloadJson,
      extra?.payload_bytes ?? (payloadJson ? Buffer.byteLength(payloadJson) : null),
      extra?.payload_shape_hash ?? null, extra?.sanitize_error ?? null, extra?.artifact_id ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  getObservation(id: number): Row | undefined {
    return this.#db.prepare('SELECT * FROM observation WHERE id=?').get(id);
  }
  observationsForRequest(accountId: string, requestId: string): Row[] {
    return this.#db.prepare('SELECT * FROM observation WHERE account_id=? AND request_id=? ORDER BY id').all(accountId, requestId);
  }

  // ---- conversations / branches / turns / parts ----
  upsertConversation(input: {
    accountId: string; externalRef?: string | null; source: 'live' | 'backfill' | 'import'; mode?: 'battle' | 'direct' | 'side_by_side' | 'unknown';
    observedAt: number; conversationId?: string;
  }): string {
    if (input.conversationId) {
      const row = this.#db.prepare('SELECT id, external_ref FROM conversation WHERE id=?').get(input.conversationId) as Row | undefined;
      if (row) {
        const ext = String(row.external_ref ?? '');
        const want = input.externalRef ?? '';
        if (ext !== '' && want !== '' && ext !== want) {
          // never silently rebind conversation identity (§2 rule 1)
          this.#db.prepare('INSERT INTO conflict (id, account_id, kind, detail_json, created_at) VALUES (?,?,?,?,?)')
            .run(newId('cf'), input.accountId, 'ownership_conflict', canonicalJson({ stored: ext, incoming: want }), Date.now());
          throw new ArchiveError('E_SCOPE_MISMATCH', 'conversation external ref conflict');
        }
        this.#db.prepare('UPDATE conversation SET last_observed_at=?, external_ref=COALESCE(external_ref, ?) WHERE id=?')
          .run(input.observedAt, want || null, input.conversationId);
        return input.conversationId;
      }
      this.#db.prepare('INSERT INTO conversation (id, account_id, external_ref, source, mode, first_observed_at, last_observed_at) VALUES (?,?,?,?,?,?,?)')
        .run(input.conversationId, input.accountId, input.externalRef ?? null, input.source, input.mode ?? 'unknown', input.observedAt, input.observedAt);
      return input.conversationId;
    }
    // Observed external ref: key the conversation on it (idempotent upsert).
    if (input.externalRef) {
      const row = this.#db.prepare('SELECT id, mode FROM conversation WHERE account_id=? AND external_ref=?').get(input.accountId, input.externalRef) as Row | undefined;
      if (row) {
        this.#db.prepare('UPDATE conversation SET last_observed_at=?, mode=COALESCE(?, mode) WHERE id=?')
          .run(input.observedAt, input.mode ?? null, String(row.id));
        return String(row.id);
      }
      const id = newId('conv');
      this.#db.prepare('INSERT INTO conversation (id, account_id, external_ref, source, mode, first_observed_at, last_observed_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, input.accountId, input.externalRef, input.source, input.mode ?? 'unknown', input.observedAt, input.observedAt);
      return id;
    }
    // No observed external ref: mint a local id; identity stays explicitly unknown.
    const id = newId('conv');
    this.#db.prepare('INSERT INTO conversation (id, account_id, external_ref, source, mode, first_observed_at, last_observed_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.accountId, null, input.source, input.mode ?? 'unknown', input.observedAt, input.observedAt);
    return id;
  }

  ensureBranch(conversationId: string, origin: 'initial' | 'regeneration' | 'retry' | 'edit', parentBranchId?: string | null): string {
    if (origin === 'initial' && !parentBranchId) {
      const row = this.#db.prepare(`SELECT id FROM branch WHERE conversation_id=? AND origin='initial' LIMIT 1`).get(conversationId) as Row | undefined;
      if (row) return String(row.id);
    }
    const id = newId('br');
    this.#db.prepare('INSERT INTO branch (id, conversation_id, parent_branch_id, origin, created_at) VALUES (?,?,?,?,?)')
      .run(id, conversationId, parentBranchId ?? null, origin, Date.now());
    return id;
  }

  listBranches(conversationId: string): Row[] {
    return this.#db.prepare('SELECT id, parent_branch_id, origin, created_at FROM branch WHERE conversation_id=? ORDER BY created_at').all(conversationId);
  }

  insertTurn(input: {
    branchId: string; seq: number; role: 'user' | 'assistant' | 'system'; completeness: CompletenessState;
    terminalEvidence?: Record<string, unknown> | null; streamStats?: Record<string, unknown> | null;
    startedAt?: number | null; endedAt?: number | null; turnId?: string;
  }): string {
    const id = input.turnId ?? newId('turn');
    this.#db.prepare('INSERT INTO turn (id, branch_id, seq, role, completeness, terminal_evidence_json, stream_stats_json, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.branchId, input.seq, input.role, input.completeness,
        input.terminalEvidence ? canonicalJson(input.terminalEvidence) : null,
        input.streamStats ? canonicalJson(input.streamStats) : null,
        input.startedAt ?? null, input.endedAt ?? null);
    return id;
  }

  updateTurnCompleteness(turnId: string, completeness: CompletenessState, terminalEvidence: Record<string, unknown>): void {
    this.#db.prepare('UPDATE turn SET completeness=?, terminal_evidence_json=? WHERE id=?')
      .run(completeness, canonicalJson(terminalEvidence), turnId);
  }

  insertPart(turnId: string, idx: number, kind: string, content: unknown, provenanceObsIds: number[]): string {
    const id = newId('part');
    this.#db.prepare('INSERT INTO part (id, turn_id, idx, kind, content_json) VALUES (?,?,?,?,?)')
      .run(id, turnId, idx, kind, canonicalJson(content));
    const ins = this.#db.prepare('INSERT OR IGNORE INTO provenance_link (entity_table, entity_id, field, observation_id) VALUES (?,?,?,?)');
    for (const oid of provenanceObsIds) ins.run('part', id, 'content_json', oid);
    // FTS index for text-bearing parts (disposable projection, rebuildable)
    const text = extractSearchableText(content);
    if (text) {
      const account = this.#db.prepare(`SELECT a.account_id FROM turn t JOIN branch b ON b.id=t.branch_id JOIN conversation c ON c.id=b.conversation_id JOIN account a ON a.account_id=c.account_id WHERE t.id=?`).get(turnId) as Row | undefined;
      this.#db.prepare('INSERT INTO part_fts (text, part_id, turn_id, account_id) VALUES (?,?,?,?)')
        .run(text, id, turnId, account ? String(account.account_id) : 'unknown');
    }
    return id;
  }

  getTurn(turnId: string): { turn: Row; parts: Row[] } | undefined {
    const turn = this.#db.prepare('SELECT * FROM turn WHERE id=?').get(turnId) as Row | undefined;
    if (!turn) return undefined;
    const parts = this.#db.prepare('SELECT * FROM part WHERE turn_id=? ORDER BY idx').all(turnId) as Row[];
    return { turn, parts };
  }

  getConversation(conversationId: string): { conversation: Row; branches: Row[] } | undefined {
    const conversation = this.#db.prepare('SELECT * FROM conversation WHERE id=?').get(conversationId) as Row | undefined;
    if (!conversation) return undefined;
    const branches = this.#db.prepare('SELECT * FROM branch WHERE conversation_id=? ORDER BY created_at').all(conversationId) as Row[];
    return { conversation, branches };
  }

  getBranchTurns(branchId: string): Row[] {
    return this.#db.prepare('SELECT * FROM turn WHERE branch_id=? ORDER BY seq').all(branchId) as Row[];
  }

  provenanceFor(entityTable: string, entityId: string): Row[] {
    return this.#db.prepare('SELECT * FROM provenance_link WHERE entity_table=? AND entity_id=?').all(entityTable, entityId) as Row[];
  }

  // ---- participants & identity claims (append-only evidence; resolved = view) ----
  ensureParticipant(conversationId: string, position: number): string {
    const existing = this.#db.prepare('SELECT id FROM participant WHERE conversation_id=? AND position=?').get(conversationId, position) as Row | undefined;
    if (existing) return String(existing.id);
    const id = newId('partcip');
    this.#db.prepare('INSERT INTO participant (id, conversation_id, position) VALUES (?,?,?)').run(id, conversationId, position);
    return id;
  }

  addIdentityClaim(input: {
    participantId: string; type: 'position' | 'blind_label' | 'selected_label' | 'request_catalog_id' | 'displayed_name' | 'post_vote_reveal';
    value: string; scopeFrom?: number | null; scopeTo?: number | null; observationId?: number | null;
  }): string {
    const id = newId('idc');
    this.#db.prepare('INSERT INTO identity_claim (id, participant_id, type, value, scope_from, scope_to, observation_id) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.participantId, input.type, input.value, input.scopeFrom ?? null, input.scopeTo ?? null, input.observationId ?? null);
    if (input.type === 'blind_label') this.#db.prepare('UPDATE participant SET blind_label=? WHERE id=?').run(input.value, input.participantId);
    if (input.type === 'selected_label') this.#db.prepare('UPDATE participant SET selected_label=? WHERE id=?').run(input.value, input.participantId);
    this.recomputeResolvedIdentity(input.participantId);
    return id;
  }

  /**
   * Resolved identity is a VIEW recomputed by precedence over the append-only
   * claims (§10.1): reveal > selected label > displayed name > catalog id.
   * The claims themselves are never mutated or deleted here.
   */
  recomputeResolvedIdentity(participantId: string): void {
    const PRECEDENCE: Record<string, { rank: number; resolution: string }> = {
      post_vote_reveal: { rank: 4, resolution: 'revealed' },
      selected_label: { rank: 3, resolution: 'selected' },
      displayed_name: { rank: 2, resolution: 'revealed' },
      request_catalog_id: { rank: 1, resolution: 'request_catalog' },
    };
    const claims = this.identityEvidence(participantId) as Row[];
    let best: { value: string; resolution: string; rank: number } | null = null;
    for (const c of claims) {
      const p = PRECEDENCE[String(c.type)];
      if (!p) continue;
      if (!best || p.rank >= best.rank) best = { value: String(c.value), resolution: p.resolution, rank: p.rank };
    }
    this.#db.prepare('UPDATE participant SET resolved_name=?, resolution=? WHERE id=?')
      .run(best?.value ?? null, best?.resolution ?? 'unresolved', participantId);
  }

  identityEvidence(participantId: string): Row[] {
    return this.#db.prepare('SELECT * FROM identity_claim WHERE participant_id=? ORDER BY id').all(participantId) as Row[];
  }

  // ---- conflicts ----
  recordConflict(accountId: string, kind: string, detail: Record<string, unknown>, observationIds?: number[]): string {
    const id = newId('cf');
    this.#db.prepare('INSERT INTO conflict (id, account_id, kind, detail_json, observation_ids, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, accountId, kind, canonicalJson(detail), observationIds ? canonicalJson(observationIds) : null, Date.now());
    return id;
  }
  listConflicts(accountId?: string): Row[] {
    return accountId
      ? this.#db.prepare('SELECT * FROM conflict WHERE account_id=? ORDER BY created_at DESC').all(accountId) as Row[]
      : this.#db.prepare('SELECT * FROM conflict ORDER BY created_at DESC').all() as Row[];
  }

  // ---- search (FTS + cursor pagination, opaque cursors) ----
  search(opts: { accountId: string; query: string; cursor?: string | null; limit?: number }): { rows: Row[]; next_cursor: string | null } {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
    const offset = decodeCursor(opts.cursor);
    const rows = this.#db.prepare(
      `SELECT f.turn_id, f.part_id, snippet(part_fts, 0, '[', ']', '…', 18) AS snippet,
              t.completeness, c.id AS conversation_id, b.id AS branch_id
       FROM part_fts f
       JOIN turn t ON t.id = f.turn_id
       JOIN branch b ON b.id = t.branch_id
       JOIN conversation c ON c.id = b.conversation_id
       WHERE part_fts MATCH ? AND f.account_id = ? AND c.suppressed = 0
       ORDER BY f.rowid DESC LIMIT ? OFFSET ?`
    ).all(sanitizeFtsQuery(opts.query), opts.accountId, limit + 1, offset) as Row[];
    const hasMore = rows.length > limit;
    const out = rows.slice(0, limit);
    return { rows: out, next_cursor: hasMore ? encodeCursor(offset + limit) : null };
  }

  // ---- tombstones / suppression / scoped deletion ----
  writeTombstone(input: { accountId: string; scope: 'conversation' | 'account' | 'archive'; targetId: string; scopeHash: string; directiveId: string }): string {
    const id = newId('tomb');
    this.#db.prepare('INSERT INTO tombstone (id, account_id, scope, target_id, scope_hash, directive_id, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.accountId, input.scope, input.targetId, input.scopeHash, input.directiveId, Date.now());
    this.#db.prepare('INSERT OR REPLACE INTO suppression_marker (target_id, reason, created_at) VALUES (?,?,?)')
      .run(input.targetId, 'deleted_by_directive', Date.now());
    return id;
  }

  deleteConversationScoped(conversationId: string): { turns: number; parts: number; observations: number } {
    return this.#db.transaction(() => {
      const turns = this.#db.prepare('SELECT id FROM turn WHERE branch_id IN (SELECT id FROM branch WHERE conversation_id=?)').all(conversationId) as Row[];
      const turnIds = turns.map((t) => String(t.id));
      let parts = 0;
      const delPart = this.#db.prepare('DELETE FROM part WHERE id=?');
      const delProv = this.#db.prepare('DELETE FROM provenance_link WHERE entity_table=? AND entity_id=?');
      for (const tid of turnIds) {
        const partRows = this.#db.prepare('SELECT id FROM part WHERE turn_id=?').all(tid) as Row[];
        for (const pr of partRows) {
          delProv.run('part', String(pr.id));
          parts += Number(delPart.run(String(pr.id)).changes);
        }
        this.#db.prepare('DELETE FROM part_fts WHERE turn_id=?').run(tid);
      }
      for (const tid of turnIds) this.#db.prepare('DELETE FROM turn WHERE id=?').run(tid);
      this.#db.prepare('DELETE FROM branch WHERE conversation_id=?').run(conversationId);
      const obsIds = this.#db.prepare('SELECT id FROM observation WHERE account_id IN (SELECT account_id FROM conversation WHERE id=?)').all(conversationId) as Row[];
      void obsIds;
      // Observation journal is append-only durable evidence: rows are *suppressed* by marker
      // and excluded from all queries through conversation rows; physical journal compaction
      // is an explicit maintenance step (vacuum path), never implicit.
      this.#db.prepare('UPDATE conversation SET suppressed=1 WHERE id=?').run(conversationId);
      const artifactCount = this.#db.prepare('SELECT id, blob_path FROM artifact WHERE conversation_id=?').all(conversationId) as Row[];
      return { turns: turnIds.length, parts, observations: artifactCount.length };
    });
  }

  countOpenConflicts(accountId: string): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS c FROM conflict WHERE account_id=? AND resolved_at IS NULL').get(accountId) as { c: number }).c);
  }

  closeConflict(id: string): void {
    this.#db.prepare('UPDATE conflict SET resolved_at=? WHERE id=?').run(Date.now(), id);
  }

  countsByCompleteness(accountId: string): Record<string, number> {
    const rows = this.#db.prepare(`
      SELECT t.completeness AS state, COUNT(*) AS n
      FROM turn t JOIN branch b ON b.id=t.branch_id JOIN conversation c ON c.id=b.conversation_id
      WHERE c.account_id=? AND c.suppressed=0
      GROUP BY t.completeness`).all(accountId) as { state: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = Number(r.n);
    return out;
  }

  ftsRebuild(): number {
    return this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM part_fts').run();
      const rows = this.#db.prepare(`
        SELECT p.id AS part_id, p.turn_id AS turn_id, p.content_json AS content, c.account_id AS account_id
        FROM part p JOIN turn t ON t.id=p.turn_id JOIN branch b ON b.id=t.branch_id JOIN conversation c ON c.id=b.conversation_id
        WHERE c.suppressed=0`).all() as Row[];
      const ins = this.#db.prepare('INSERT INTO part_fts (text, part_id, turn_id, account_id) VALUES (?,?,?,?)');
      let n = 0;
      for (const r of rows) {
        let parsed: unknown = null;
        try { parsed = JSON.parse(String(r.content)); } catch { /* keep skip */ }
        const text = extractSearchableText(parsed);
        if (text) { ins.run(text, String(r.part_id), String(r.turn_id), String(r.account_id)); n++; }
      }
      return n;
    });
  }

  // ---- protocol catalog persistence (service owns writes; catalog owns logic) ----
  persistCatalog(snapshotJson: string): void {
    this.#db.prepare(`INSERT INTO meta (key, value) VALUES ('protocol_catalog', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(snapshotJson);
  }
  loadCatalog(): Row | undefined {
    return this.#db.prepare(`SELECT value FROM meta WHERE key='protocol_catalog'`).get() as Row | undefined;
  }

  health(): { tables: number; observations: number; turns: number; fts: number } {
    const c = (sql: string) => Number((this.#db.prepare(sql).get() as { n: number }).n);
    return {
      tables: c(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`),
      observations: c('SELECT COUNT(*) AS n FROM observation'),
      turns: c('SELECT COUNT(*) AS n FROM turn'),
      fts: c('SELECT COUNT(*) AS n FROM part_fts'),
    };
  }
}

function extractSearchableText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (Array.isArray(o.content)) return o.content.map((x) => extractSearchableText(x)).join(' ');
  }
  return '';
}

function sanitizeFtsQuery(q: string): string {
  return q.replace(/["'()*^]/g, ' ').split(/\s+/).filter(Boolean).map((w) => `"${w}"`).join(' AND ');
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}:${sha256Hex(String(offset)).slice(0, 8)}`, 'utf8').toString('base64url');
}
function decodeCursor(c?: string | null): number {
  if (!c) return 0;
  const s = Buffer.from(c, 'base64url').toString('utf8');
  const m = /^o:(\d+):([a-f0-9]{8})$/.exec(s);
  if (!m) throw new ArchiveError('E_INVALID_ARGS', 'bad cursor');
  const off = Number(m[1]);
  if (sha256Hex(String(off)).slice(0, 8) !== m[2]) throw new ArchiveError('E_INVALID_ARGS', 'cursor checksum mismatch');
  return off;
}
