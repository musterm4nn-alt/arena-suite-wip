import { CorpusSnapshot } from '../corpus/CorpusSnapshot.js';
import { Metrics, type MetricResult } from '../metrics/Metrics.js';

/**
 * v1 research engine is deterministic
 * Every metric returns sample count and cohort definition
 * Representative excerpts chosen deterministically and link back to provenance
 */

export interface Profile {
  corpus_snapshot: CorpusSnapshot;
  metrics: MetricResult[];
  excerpts: Array<{ text: string; turn_id: string; provenance: string }>;
  created_at: string;
}

export class DeterministicProfiler {
  static run(
    snapshot: CorpusSnapshot,
    turns: Array<{ id: string; text: string; conversation_id: string; tool_calls?: number; reasoning_present?: boolean }>
  ): Profile {
    const allMetrics: MetricResult[] = [];

    for (const turn of turns) {
      allMetrics.push(...Metrics.structureMetrics(turn.text));
      allMetrics.push(...Metrics.lexicalMetrics(turn.text));
      allMetrics.push(...Metrics.discourseMetrics(turn.text));
      allMetrics.push(...Metrics.interactiveMetrics({ tool_calls: turn.tool_calls, reasoning_present: turn.reasoning_present }));
    }

    // Aggregate by metric name — deterministic
    const aggregated = new Map<string, MetricResult>();
    for (const m of allMetrics) {
      const existing = aggregated.get(m.name);
      if (!existing) {
        aggregated.set(m.name, { ...m, sample_count: 1 });
      } else {
        // Average
        const totalCount = existing.sample_count + 1;
        existing.value = (existing.value * existing.sample_count + m.value) / totalCount;
        existing.sample_count = totalCount;
      }
    }

    // Deterministic excerpts: sort by turn_id and take first 3
    const sortedTurns = turns.slice().sort((a, b) => a.id.localeCompare(b.id));
    const excerpts = sortedTurns.slice(0, 3).map(t => ({
      text: t.text.slice(0, 200),
      turn_id: t.id,
      provenance: `turn:${t.id} conversation:${t.conversation_id}`,
    }));

    return {
      corpus_snapshot: snapshot,
      metrics: Array.from(aggregated.values()),
      excerpts,
      created_at: new Date().toISOString(),
    };
  }
}
