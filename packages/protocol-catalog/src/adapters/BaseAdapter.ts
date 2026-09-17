/**
 * Adapter base — each payload family gets its own adapter with versioning and drift counters
 */

export interface AdapterContext {
  accountId: string;
  sessionEpochId: string | null;
  operationId: string;
  observedAt: string;
}

export interface AdapterResult {
  success: boolean;
  normalized?: unknown;
  errorCode?: string;
  byteLength?: number;
  shapeHash?: string;
  // On failure, persist only error code, byte length and shape hash — never dump raw bytes
}

export abstract class BaseAdapter {
  abstract readonly id: string;
  abstract readonly version: string;
  abstract readonly payloadFamily: string;

  abstract parse(raw: unknown, ctx: AdapterContext): Promise<AdapterResult>;

  // For protocol catalog classification
  getId(): string {
    return this.id;
  }
  getVersion(): string {
    return this.version;
  }
}
