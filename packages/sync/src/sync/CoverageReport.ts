/**
 * Coverage is a report, not a boolean — section 9.3
 */

export interface Coverage {
  account_id: string;
  listing_method: string;
  listing_verified_at: string | null;
  newest_seen: string | null;
  oldest_seen: string | null;
  items_known: number;
  items_archived: number;
  items_complete: number;
  items_partial: number;
  items_unknown_content: number;
  detail_failures: number;
  pagination_gaps: Array<{ cursor: string | null; reason: string }>;
  ownership_conflicts: Array<{ conversation_id: string; reason: string }>;
  adapter_gaps: Array<{ operation_id: string; reason: string }>;
  last_run: string | null;
  confidence_statement: string;
}

export class CoverageReporter {
  build(partial: Partial<Coverage> & { account_id: string }): Coverage {
    const now = new Date().toISOString();
    return {
      account_id: partial.account_id,
      listing_method: partial.listing_method ?? 'unknown',
      listing_verified_at: partial.listing_verified_at ?? null,
      newest_seen: partial.newest_seen ?? null,
      oldest_seen: partial.oldest_seen ?? null,
      items_known: partial.items_known ?? 0,
      items_archived: partial.items_archived ?? 0,
      items_complete: partial.items_complete ?? 0,
      items_partial: partial.items_partial ?? 0,
      items_unknown_content: partial.items_unknown_content ?? 0,
      detail_failures: partial.detail_failures ?? 0,
      pagination_gaps: partial.pagination_gaps ?? [],
      ownership_conflicts: partial.ownership_conflicts ?? [],
      adapter_gaps: partial.adapter_gaps ?? [],
      last_run: partial.last_run ?? now,
      confidence_statement: partial.confidence_statement ?? this.defaultConfidence(partial),
    };
  }

  private defaultConfidence(c: Partial<Coverage>): string {
    if (!c.listing_verified_at) {
      return 'Historical completeness is unknown — no reliable listing exists. Live capture continues; controlled history traversal and rendered history build a map of known conversations.';
    }
    if ((c.pagination_gaps?.length ?? 0) > 0) {
      return `Pagination instability detected with ${c.pagination_gaps?.length} gaps. Coverage is partial.`;
    }
    if ((c.items_known ?? 0) === (c.items_archived ?? 0) && (c.detail_failures ?? 0) === 0) {
      return 'All known items archived with no detail failures. High confidence in coverage for listed range.';
    }
    return `Archived ${c.items_archived}/${c.items_known} known items. ${c.items_complete} complete, ${c.items_partial} partial, ${c.items_unknown_content} unknown content, ${c.detail_failures} detail failures.`;
  }
}
