/**
 * Observation journal: single-writer serialized append path.
 * Validates against @arena/schema, sanitizes the payload, then persists.
 */
import { z } from "zod";
import { ObservationSchema } from "@arena/schema";
import { sanitizeJson, SanitizeError, shapeHashOfJson } from "@arena/security";
import type { ArchiveDriver, ObservationRow } from "./driver.js";

/** Pre-parse (unbranded) observation input — appendNow validates at runtime. */
export type JournalObservationInput = Omit<z.input<typeof ObservationSchema>, "id"> & {
  id?: string;
};

export interface JournalAppend {
  observation: JournalObservationInput;
  /** Raw evidence — sanitized here, never persisted raw. */
  evidence?: unknown;
}

export class ObservationJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly driver: ArchiveDriver) {}

  /** Serialized append. Resolves with the stored observation id. */
  append(entry: JournalAppend): Promise<string> {
    const run = this.queue.then(() => this.appendNow(entry));
    // Keep the chain alive across failures; callers still see their error.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async appendNow(entry: JournalAppend): Promise<string> {
    const { randomUUID } = await import("node:crypto");
    const id = entry.observation.id ?? randomUUID();
    const parsed = ObservationSchema.parse({ ...entry.observation, id });
    let payloadJson: string | null = null;
    if (entry.evidence !== undefined) {
      try {
        payloadJson = JSON.stringify(sanitizeJson(entry.evidence));
      } catch (err) {
        // Fail closed: error code + byte length + shape hash only (plan §8).
        const code = err instanceof SanitizeError ? err.code : "E_SANITIZE";
        const raw = safeByteLength(entry.evidence);
        payloadJson = JSON.stringify({
          __sanitize_failed__: true,
          errorCode: code,
          byteLength: raw,
          shapeHash: shapeHashOfStringLenient(entry.evidence),
        });
      }
    }
    const row: ObservationRow = {
      id: parsed.id,
      account_id: parsed.account_id,
      session_epoch_id: parsed.session_epoch_id,
      mechanism: parsed.mechanism,
      target_id: parsed.target_id,
      cdp_session_id: parsed.cdp_session_id,
      operation_key: parsed.operation_key,
      adapter_id: parsed.adapter_id,
      adapter_version: parsed.adapter_version,
      observed_at_ms: parsed.observed_at_ms,
      completeness: parsed.completeness,
      evidence_ref: parsed.evidence_ref,
      observer_gap: parsed.observer_gap ? 1 : 0,
      payload_json: payloadJson,
    };
    await this.driver.insertObservation(row);
    return parsed.id;
  }
}

function safeByteLength(v: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
  } catch {
    return -1;
  }
}

function shapeHashOfStringLenient(v: unknown): string {
  try {
    return shapeHashOfJson(v);
  } catch {
    return "unknown";
  }
}
