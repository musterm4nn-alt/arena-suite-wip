import { createHash } from 'node:crypto';

/**
 * Deterministic analysis operates on immutable corpus snapshots identified by corpus hash plus adapter/code/config versions
 * By default includes only complete turns whose model cohort is based on observed/revealed identity evidence
 */

export interface CorpusFilter {
  completeness: string[];
  identity_evidence: 'observed' | 'revealed' | 'any' | 'unknown';
  account_ids: string[] | null;
}

export interface CorpusSnapshot {
  id: string;
  hash: string;
  filter: CorpusFilter;
  adapter_versions: Record<string, string>;
  code_version: string;
  created_at: string;
  turn_count: number;
  conversation_count: number;
}

export class CorpusSnapshotBuilder {
  static build(
    turns: Array<{ id: string; completeness: string; account_id: string; conversation_id: string; text: string }>,
    filter: CorpusFilter,
    meta: { adapter_versions: Record<string, string>; code_version: string }
  ): CorpusSnapshot {
    const filtered = turns.filter(t => {
      if (filter.completeness.length > 0 && !filter.completeness.includes(t.completeness)) return false;
      if (filter.account_ids && filter.account_ids.length > 0 && !filter.account_ids.includes(t.account_id)) return false;
      return true;
    });

    const hashInput = JSON.stringify({
      filter,
      adapter_versions: meta.adapter_versions,
      code_version: meta.code_version,
      turn_ids: filtered.map(t => t.id).sort(),
    });
    const hash = createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
    const conversations = new Set(filtered.map(t => t.conversation_id));

    return {
      id: `corpus-${hash}`,
      hash,
      filter,
      adapter_versions: meta.adapter_versions,
      code_version: meta.code_version,
      created_at: new Date().toISOString(),
      turn_count: filtered.length,
      conversation_count: conversations.size,
    };
  }
}
