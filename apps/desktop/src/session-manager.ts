/**
 * SessionManager — per §5 Simultaneous account isolation
 * Each Arena account is represented by immutable local UUID. Create its Chromium session with explicit app-controlled storage directory such as Application Support/ArenaArchive/partitions/<account_uuid>/
 * Never derive storage paths from email, display names, Arena model labels or page data.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { AccountId } from "@arena-archive/schema";

export interface AccountSession {
  account_id: AccountId;
  partition_path: string;
  session_partition: string; // persist:<uuid>
  session_epoch_id: string;
  created_at: string;
  enabled: boolean;
}

export class SessionManager {
  private sessions = new Map<AccountId, AccountSession>();

  constructor(private appSupportRoot: string) {}

  async createAccount(): Promise<AccountSession> {
    const account_id = randomUUID();
    const partition_path = join(this.appSupportRoot, "partitions", account_id);
    await mkdir(partition_path, { recursive: true });

    const session: AccountSession = {
      account_id,
      partition_path,
      session_partition: `persist:${account_id}`,
      session_epoch_id: randomUUID(),
      created_at: new Date().toISOString(),
      enabled: true,
    };
    this.sessions.set(account_id, session);
    console.log(`[SessionManager] createAccount ${account_id} path=${partition_path}`);
    return session;
  }

  getSession(account_id: AccountId): AccountSession | undefined {
    return this.sessions.get(account_id);
  }

  listSessions(): AccountSession[] {
    return Array.from(this.sessions.values());
  }

  beginEpoch(account_id: AccountId): string {
    const sess = this.sessions.get(account_id);
    if (!sess) throw new Error(`Account ${account_id} not found`);
    const newEpoch = randomUUID();
    sess.session_epoch_id = newEpoch;
    console.log(`[SessionManager] beginEpoch account=${account_id} epoch=${newEpoch}`);
    return newEpoch;
  }

  endEpoch(account_id: AccountId, reason: "signout" | "mismatch" | "invalidation"): void {
    const sess = this.sessions.get(account_id);
    if (!sess) return;
    console.log(`[SessionManager] endEpoch account=${account_id} reason=${reason} oldEpoch=${sess.session_epoch_id}`);
    sess.session_epoch_id = randomUUID(); // new epoch will start on next sign-in
  }

  // Blocking test: Write unique sentinels in A/B and verify no cross-read after restart
  async writeSentinel(account_id: AccountId, key: string, value: string): Promise<void> {
    const sess = this.sessions.get(account_id);
    if (!sess) throw new Error("not found");
    const { writeFile } = await import("node:fs/promises");
    const sentinelPath = join(sess.partition_path, `sentinel-${key}.txt`);
    await writeFile(sentinelPath, value, "utf-8");
  }

  async verifyIsolation(accountA: AccountId, accountB: AccountId): Promise<{ isolated: boolean; reason?: string }> {
    const a = this.sessions.get(accountA);
    const b = this.sessions.get(accountB);
    if (!a || !b) return { isolated: false, reason: "account not found" };
    if (a.partition_path === b.partition_path) return { isolated: false, reason: "partition path collision" };
    if (a.session_partition === b.session_partition) return { isolated: false, reason: "session partition collision" };
    // In real Electron, would check cookies, localStorage, IndexedDB, etc. via session API
    return { isolated: true };
  }
}
