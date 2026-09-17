import type { JournalEntry } from '../journal/ObservationJournal.js';
import { ChatAdapter, type BaseAdapter } from '@arena/protocol-catalog';

/**
 * Normalizer — converts sanitized observations into relational core (conversations, branches, turns, parts)
 * Uses three-layer hybrid: append-only sanitized observations, normalized relational core, disposable derived projections
 */

export interface NormalizedTurn {
  conversation_id: string;
  branch_id: string;
  turn_id: string;
  account_id: string;
  role: string;
  text: string;
  position: number;
  completeness: string;
  observation_id: string;
}

export class Normalizer {
  private adapters: Map<string, BaseAdapter> = new Map();

  constructor() {
    const chat = new ChatAdapter();
    this.adapters.set(chat.id, chat);
  }

  registerAdapter(adapter: BaseAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async normalize(entry: JournalEntry): Promise<NormalizedTurn | null> {
    // Route to appropriate adapter based on operation_key / payload_family
    // For now, try chat adapter if evidence looks like chat
    const raw = entry.raw_sanitized;
    if (!raw || typeof raw !== 'object') return null;

    // Find best adapter — in real system, protocol catalog decides
    for (const adapter of this.adapters.values()) {
      const result = await adapter.parse(raw, {
        accountId: entry.account_id,
        sessionEpochId: entry.session_epoch_id,
        operationId: entry.operation_key ?? 'unknown',
        observedAt: entry.observed_at,
      });
      if (result.success && result.normalized) {
        const norm = result.normalized as Record<string, unknown>;
        return {
          conversation_id: (norm.conversation_id as string) ?? 'unknown',
          branch_id: (norm.branch_id as string) ?? 'main',
          turn_id: (norm.turn_id as string) ?? entry.id,
          account_id: entry.account_id,
          role: (norm.role as string) ?? 'assistant',
          text: (norm.text as string) ?? '',
          position: (norm.position as number) ?? 0,
          completeness: entry.completeness_state,
          observation_id: entry.id,
        };
      }
    }
    return null;
  }
}
