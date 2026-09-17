/**
 * @arena/analysis — deterministic v1 research engine (plan §13).
 *
 * Operates on immutable corpus snapshots (corpus hash + adapter/code/config
 * versions). Default cohort: only `complete` turns with observed/revealed
 * identity evidence. Every metric returns sample count + cohort definition.
 * Fingerprinting/similarity inference lives behind the §13.2 gate and can
 * NEVER mutate observed identity.
 */
import { createHash } from "node:crypto";
import type { Completeness } from "@arena/schema";

export interface CorpusTurn {
  turnId: string;
  accountId: string;
  conversationId: string;
  completeness: Completeness;
  /** Observed/revealed cohort label, or null when identity is unknown. */
  cohort: string | null;
  text: string;
  /** Prompt that produced this turn (for matched-prompt slices). */
  promptHash: string | null;
  observedAtMs: number;
}

export interface CohortDefinition {
  /** Completeness states included. Default: ["complete"] only. */
  completeness: Completeness[];
  /** Cohort labels included; null entries excluded unless explicitly requested. */
  cohorts: string[] | "all-known";
  includeUnknownIdentity: boolean;
}

export const DEFAULT_COHORT: CohortDefinition = {
  completeness: ["complete"],
  cohorts: "all-known",
  includeUnknownIdentity: false,
};

export function filterCorpus(turns: CorpusTurn[], def: CohortDefinition): CorpusTurn[] {
  return turns.filter((t) => {
    if (!def.completeness.includes(t.completeness)) return false;
    if (t.cohort === null && !def.includeUnknownIdentity) return false;
    if (t.cohort === null) return true;
    if (def.cohorts === "all-known") return true;
    return def.cohorts.includes(t.cohort);
  });
}

export function corpusHash(turns: CorpusTurn[]): string {
  const canonical = [...turns]
    .sort((a, b) => (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0))
    .map((t) => `${t.turnId}:${createHash("sha256").update(t.text, "utf8").digest("hex")}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Structure metrics (family 1 of plan §13 table)
// ---------------------------------------------------------------------------

export interface StructureMetrics {
  sampleCount: number;
  chars: number[];
  paragraphs: number[];
  sentences: number[];
  codeBlocks: number[];
  headings: number[];
  lists: number[];
  tables: number[];
  codeCharsRatio: number[];
}

export function structureMetrics(texts: string[]): StructureMetrics {
  const chars: number[] = [];
  const paragraphs: number[] = [];
  const sentences: number[] = [];
  const codeBlocks: number[] = [];
  const headings: number[] = [];
  const lists: number[] = [];
  const tables: number[] = [];
  const codeCharsRatio: number[] = [];
  for (const text of texts) {
    const charCount = [...text].length;
    chars.push(charCount);
    // Prose metrics ignore fenced code blocks (code is measured separately).
    const prose = text.replace(/```[\s\S]*?```/g, "");
    paragraphs.push(prose.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length);
    sentences.push(prose.split(/[.!?…]+/).filter((s) => s.trim().length > 0).length);
    const fences = (text.match(/```/g) ?? []).length;
    codeBlocks.push(Math.floor(fences / 2));
    headings.push(text.split("\n").filter((l) => /^#{1,6}\s/.test(l)).length);
    lists.push(text.split("\n").filter((l) => /^\s*([-*+]|\d+[.)])\s/.test(l)).length);
    tables.push(text.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l)).length);
    const codeChars = [...(text.match(/```[\s\S]*?```/g) ?? []).join("")].length;
    codeCharsRatio.push(charCount === 0 ? 0 : codeChars / charCount);
  }
  return {
    sampleCount: texts.length,
    chars,
    paragraphs,
    sentences,
    codeBlocks,
    headings,
    lists,
    tables,
    codeCharsRatio,
  };
}

export interface LexicalMetrics {
  sampleCount: number;
  /** Type/token ratio over a moving window (deterministic). */
  movingTtr: number[];
  questionMarks: number[];
  exclamations: number[];
}

export function lexicalMetrics(texts: string[], window = 100): LexicalMetrics {
  const movingTtr: number[] = [];
  const questionMarks: number[] = [];
  const exclamations: number[] = [];
  for (const text of texts) {
    const tokens = text.toLowerCase().split(/[\s—–-]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      movingTtr.push(0);
    } else if (tokens.length <= window) {
      movingTtr.push(new Set(tokens).size / tokens.length);
    } else {
      let sum = 0;
      let n = 0;
      for (let i = 0; i + window <= tokens.length; i += window) {
        const slice = tokens.slice(i, i + window);
        sum += new Set(slice).size / window;
        n += 1;
      }
      movingTtr.push(n === 0 ? 0 : sum / n);
    }
    questionMarks.push((text.match(/\?/g) ?? []).length);
    exclamations.push((text.match(/!/g) ?? []).length);
  }
  return { sampleCount: texts.length, movingTtr, questionMarks, exclamations };
}

/** Deterministic excerpt selection: sort by (metric, turnId), take k. */
export function selectExcerpts(
  turns: CorpusTurn[],
  metricValues: number[],
  k: number,
  order: "top" | "bottom" = "top",
): CorpusTurn[] {
  const paired = turns.map((t, i) => ({ t, v: metricValues[i] ?? 0 }));
  paired.sort((a, b) => {
    if (a.v !== b.v) return order === "top" ? b.v - a.v : a.v - b.v;
    return a.t.turnId < b.t.turnId ? -1 : 1;
  });
  return paired.slice(0, k).map((p) => p.t);
}
