/**
 * SessionManager — one persistent Chromium session per account (plan §5).
 *
 * Storage directories are app-controlled and derived ONLY from the local
 * account UUID: `<userData>/partitions/<account_uuid>/`. Never from email,
 * display names, Arena labels, or page data.
 */
import * as path from "node:path";

export const PARTITION_ROOT_NAME = "partitions";

export function partitionPath(userDataPath: string, accountId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    throw new Error("accountId must be a UUID (never page-derived)");
  }
  return path.join(userDataPath, PARTITION_ROOT_NAME, accountId);
}

/** Electron partition string for a persistent per-account session. */
export function electronPartition(accountId: string): string {
  // Validated as UUID above so it cannot smuggle path separators.
  partitionPath("/tmp", accountId);
  return `persist:arena-${accountId}`;
}

export interface AccountRecord {
  accountId: string;
  enabled: boolean;
  epochId: string | null;
}

export class SessionManager {
  private readonly accounts = new Map<string, AccountRecord>();

  constructor(private readonly userDataPath: string) {}

  register(accountId: string, enabled = true): AccountRecord {
    partitionPath(this.userDataPath, accountId); // validates
    const rec: AccountRecord = { accountId, enabled, epochId: null };
    this.accounts.set(accountId, rec);
    return { ...rec };
  }

  /** Begin a session epoch (successful sign-in). Previous epoch ends. */
  beginEpoch(accountId: string, epochId: string): void {
    const rec = this.mustGet(accountId);
    rec.epochId = epochId;
  }

  /** End the epoch (sign-out, identity mismatch, credential invalidation). */
  endEpoch(accountId: string): void {
    const rec = this.mustGet(accountId);
    rec.epochId = null;
  }

  storagePathFor(accountId: string): string {
    this.mustGet(accountId);
    return partitionPath(this.userDataPath, accountId);
  }

  partitionFor(accountId: string): string {
    this.mustGet(accountId);
    return electronPartition(accountId);
  }

  get(accountId: string): AccountRecord | null {
    const rec = this.accounts.get(accountId);
    return rec ? { ...rec } : null;
  }

  list(): AccountRecord[] {
    return [...this.accounts.values()].map((r) => ({ ...r }));
  }

  private mustGet(accountId: string): AccountRecord {
    const rec = this.accounts.get(accountId);
    if (!rec) throw new Error(`unknown account ${accountId}`);
    return rec;
  }
}
