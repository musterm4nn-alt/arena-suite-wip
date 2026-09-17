/**
 * Deterministic metrics families per section 13
 */

export interface MetricResult {
  name: string;
  family: 'structure' | 'lexical' | 'discourse' | 'interactive' | 'variation';
  value: number;
  sample_count: number;
  cohort_definition: unknown;
  confounds: string[];
}

export class Metrics {
  // Structure: response/paragraph/sentence/code-block lengths, headings, lists, tables, citation frequency, code/prose ratio
  static structureMetrics(text: string): MetricResult[] {
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const codeBlocks = (text.match(/```/g) || []).length / 2;
    const headings = (text.match(/^#+\s/gm) || []).length;
    const lists = (text.match(/^[-*]\s/gm) || []).length;
    const tables = (text.match(/\|.*\|/g) || []).length;

    return [
      { name: 'paragraph_count', family: 'structure', value: paragraphs.length, sample_count: 1, cohort_definition: null, confounds: ['Prompt formatting requests', 'Arena rendering'] },
      { name: 'avg_sentence_length', family: 'structure', value: sentences.length > 0 ? text.length / sentences.length : 0, sample_count: sentences.length, cohort_definition: null, confounds: ['Prompt formatting'] },
      { name: 'code_block_count', family: 'structure', value: codeBlocks, sample_count: 1, cohort_definition: null, confounds: ['Topic'] },
      { name: 'heading_count', family: 'structure', value: headings, sample_count: 1, cohort_definition: null, confounds: ['Arena post-processing'] },
      { name: 'list_count', family: 'structure', value: lists, sample_count: 1, cohort_definition: null, confounds: [] },
      { name: 'table_count', family: 'structure', value: tables, sample_count: 1, cohort_definition: null, confounds: [] },
    ];
  }

  // Lexical: moving lexical diversity, recurring n-grams, punctuation/casing, emoji/symbol patterns
  static lexicalMetrics(text: string): MetricResult[] {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const unique = new Set(words);
    const ttr = words.length > 0 ? unique.size / words.length : 0;
    const emojiCount = (text.match(/[\u{1F600}-\u{1F64F}]/gu) || []).length;

    return [
      { name: 'type_token_ratio', family: 'lexical', value: ttr, sample_count: words.length, cohort_definition: null, confounds: ['Topic/language/tokenizer version'] },
      { name: 'emoji_count', family: 'lexical', value: emojiCount, sample_count: 1, cohort_definition: null, confounds: [] },
    ];
  }

  // Discourse: openings, transitions, conclusions, hedging, refusals, apologies, uncertainty markers
  static discourseMetrics(text: string): MetricResult[] {
    const lower = text.toLowerCase();
    const hedging = (lower.match(/\b(maybe|perhaps|possibly|might|could|seems)\b/g) || []).length;
    const apologies = (lower.match(/\b(sorry|apologize)\b/g) || []).length;
    const refusals = (lower.match(/\b(cannot|can't|unable to|refuse)\b/g) || []).length;

    return [
      { name: 'hedging_count', family: 'discourse', value: hedging, sample_count: 1, cohort_definition: null, confounds: ['Safety/system prompts and conversation context'] },
      { name: 'apology_count', family: 'discourse', value: apologies, sample_count: 1, cohort_definition: null, confounds: ['Safety prompts'] },
      { name: 'refusal_count', family: 'discourse', value: refusals, sample_count: 1, cohort_definition: null, confounds: ['Safety prompts'] },
    ];
  }

  // Interactive: tool counts/types, reasoning-part presence/length, finish reason, first-part/completion latency where reliable
  static interactiveMetrics(meta: { tool_calls?: number; reasoning_present?: boolean; latency_ms?: number | null }): MetricResult[] {
    return [
      { name: 'tool_call_count', family: 'interactive', value: meta.tool_calls ?? 0, sample_count: 1, cohort_definition: null, confounds: ['Different harnesses/tools/modes'] },
      { name: 'reasoning_present', family: 'interactive', value: meta.reasoning_present ? 1 : 0, sample_count: 1, cohort_definition: null, confounds: ['Harness'] },
    ];
  }
}
