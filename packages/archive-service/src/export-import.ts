import { ArchiveError, canonicalJson, sha256Hex } from '@arena/core';
import type { Row } from '@arena/schema';
import { ArchiveStore } from './store.ts';

/**
 * Export bundles are the ingestion-adapter contract (§3): what the archive can
 * hand out, and what an older/exported archive can feed back in. Imported
 * content is `source='import'`, completeness `imported`, and stays in its own
 * cohort — never laundered as live evidence (§7).
 */

export interface BundleShape {
  format: 'arena-model-archive/export';
  format_version: 1;
  account_id: string;
  exported_at: number;
  conversations: Array<{
    conversation_id: string;
    external_ref: string | null;
    source: 'live' | 'backfill' | 'import';
    mode: string;
    branches: Array<{
      branch_id: string;
      parent_branch_id: string | null;
      origin: string;
      turns: Array<{
        turn_id: string;
        seq: number;
        role: string;
        completeness: string;
        started_at: number | null;
        ended_at: number | null;
        parts: Array<{ kind: string; content: unknown }>;
        provenance_observation_ids: number[];
      }>;
    }>;
    participants: Array<{ position: number; blind_label: string | null; selected_label: string | null; resolved_name: string | null }>;
  }>;
  integrity_sha256: string;
}

export function exportBundleJson(store: ArchiveStore, accountId: string, conversationIds?: string[]): BundleShape {
  const where = conversationIds && conversationIds.length > 0
    ? `AND id IN (${conversationIds.map(() => '?').join(',')})`
    : '';
  const convs = (where
    ? store.db.prepare(`SELECT * FROM conversation WHERE account_id=? AND suppressed=0 ${where} ORDER BY last_observed_at DESC`).all(accountId, ...conversationIds!)
    : store.db.prepare('SELECT * FROM conversation WHERE account_id=? AND suppressed=0 ORDER BY last_observed_at DESC').all(accountId)) as Row[];
  const conversations = convs.map((c) => {
    const branches = store.listBranches(String(c.id)).map((b) => ({
      branch_id: String(b.id),
      parent_branch_id: b.parent_branch_id ? String(b.parent_branch_id) : null,
      origin: String(b.origin),
      turns: store.getBranchTurns(String(b.id)).map((t) => {
        const { turn, parts } = store.getTurn(String(t.id))!;
        void turn;
        return {
          turn_id: String(t.id),
          seq: Number(t.seq),
          role: String(t.role),
          completeness: String(t.completeness),
          started_at: t.started_at === null ? null : Number(t.started_at),
          ended_at: t.ended_at === null ? null : Number(t.ended_at),
          parts: parts.map((p) => ({ kind: String(p.kind), content: JSON.parse(String(p.content_json)) })),
          provenance_observation_ids: parts.flatMap((p) => store.provenanceFor('part', String(p.id)).map((pl) => Number(pl.observation_id))),
        };
      }),
    }));
    const participants = (store.db.prepare('SELECT * FROM participant WHERE conversation_id=?').all(String(c.id)) as Row[]).map((p) => ({
      position: Number(p.position),
      blind_label: p.blind_label ? String(p.blind_label) : null,
      selected_label: p.selected_label ? String(p.selected_label) : null,
      resolved_name: p.resolved_name ? String(p.resolved_name) : null,
    }));
    return {
      conversation_id: String(c.id),
      external_ref: c.external_ref ? String(c.external_ref) : null,
      source: String(c.source) as 'live' | 'backfill' | 'import',
      mode: String(c.mode),
      branches,
      participants,
    };
  });
  const body: Omit<BundleShape, 'integrity_sha256'> = {
    format: 'arena-model-archive/export',
    format_version: 1,
    account_id: accountId,
    exported_at: Date.now(),
    conversations,
  };
  const integrity_sha256 = sha256Hex(canonicalJson(body));
  return { ...body, integrity_sha256 };
}

export function importBundleJson(store: ArchiveStore, targetAccountId: string, bundle: BundleShape): { imported_conversations: number; imported_turns: number } {
  if (!bundle || bundle.format !== 'arena-model-archive/export' || bundle.format_version !== 1) {
    throw new ArchiveError('E_INVALID_ARGS', 'not an export bundle');
  }
  const { integrity_sha256, ...body } = bundle;
  if (sha256Hex(canonicalJson(body)) !== integrity_sha256) throw new ArchiveError('E_INVALID_ARGS', 'bundle integrity check failed');
  let nConv = 0, nTurn = 0;
  store.db.transaction(() => {
    for (const c of bundle.conversations) {
      const convId = store.upsertConversation({
        accountId: targetAccountId, externalRef: c.external_ref, source: 'import',
        mode: 'unknown', observedAt: bundle.exported_at,
      });
      nConv++;
      for (const b of c.branches) {
        const branchId = store.ensureBranch(convId, 'initial');
        let idx = 0;
        for (const t of b.turns) {
          const turnId = store.insertTurn({
            branchId, seq: ++idx, role: 'assistant', completeness: 'imported',
            terminalEvidence: { inherited: true, original_completeness: t.completeness },
            startedAt: t.started_at, endedAt: t.ended_at,
          });
          nTurn++;
          for (let i = 0; i < t.parts.length; i++) {
            store.insertPart(turnId, i, t.parts[i]!.kind === 'unknown' ? 'unknown' : t.parts[i]!.kind, t.parts[i]!.content, []);
          }
        }
      }
    }
  });
  return { imported_conversations: nConv, imported_turns: nTurn };
}
