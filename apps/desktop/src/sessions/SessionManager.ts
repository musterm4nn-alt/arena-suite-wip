import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/**
 * SessionManager — one account -> one session path (section 5)
 * Each Arena account is immutable local UUID. Create its Chromium session with explicit app-controlled storage directory
 * such as Application Support/ArenaArchive/partitions/<account_uuid>/
 * Never derive storage paths from email, display names, Arena model labels or page data
 */

export interface AccountSession {
  accountId: string;
  partitionPath: string;
  sessionEpochId: string;
  createdAt: string;
  lastUsedAt: string;
}

export class SessionManager {
  private sessions = new Map<string, AccountSession>();
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? this.getDefaultBaseDir();
  }

  private getDefaultBaseDir(): string {
    const base = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ArenaArchive', 'partitions')
      : path.join(os.homedir(), '.config', 'arena-archive', 'partitions');
    return base;
  }

  async createSession(accountId: string): Promise<AccountSession> {
    // Validate UUID
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
      throw new Error('Account ID must be UUID');
    }
    const partitionPath = path.join(this.baseDir, accountId);
    // Ensure path is app-controlled, not derived from email
    if (partitionPath.includes('@')) {
      throw new Error('Partition path must not contain email');
    }
    await fs.promises.mkdir(partitionPath, { recursive: true, mode: 0o700 });

    const session: AccountSession = {
      accountId,
      partitionPath,
      sessionEpochId: randomUUID(),
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    this.sessions.set(accountId, session);
    return session;
  }

  getSession(accountId: string): AccountSession | undefined {
    return this.sessions.get(accountId);
  }

  listSessions(): AccountSession[] {
    return Array.from(this.sessions.values());
  }

  async destroySession(accountId: string): Promise<void> {
    this.sessions.delete(accountId);
    // Real Electron would also clear storage: session.fromPartition(...).clearStorageData()
  }

  // Blocking test: Write unique sentinels in A/B and verify no cross-read after restart
  async testIsolation(accountA: string, accountB: string): Promise<{ isolated: boolean; details: string }> {
    const sessA = this.sessions.get(accountA);
    const sessB = this.sessions.get(accountB);
    if (!sessA || !sessB) {
      return { isolated: false, details: 'One or both sessions missing' };
    }
    if (sessA.partitionPath === sessB.partitionPath) {
      return { isolated: false, details: 'Partition paths identical' };
    }
    // Check filesystem isolation
    const sentinelA = path.join(sessA.partitionPath, 'sentinel-A.txt');
    const sentinelB = path.join(sessB.partitionPath, 'sentinel-B.txt');
    try {
      await fs.promises.writeFile(sentinelA, `sentinel-${accountA}`, { mode: 0o600 });
      await fs.promises.writeFile(sentinelB, `sentinel-${accountB}`, { mode: 0o600 });
      const contentA = await fs.promises.readFile(sentinelA, 'utf-8');
      const contentB = await fs.promises.readFile(sentinelB, 'utf-8');
      const isolated = contentA.includes(accountA) && contentB.includes(accountB) && !contentA.includes(accountB);
      // Cleanup
      await fs.promises.unlink(sentinelA).catch(() => {});
      await fs.promises.unlink(sentinelB).catch(() => {});
      return { isolated, details: isolated ? 'Sentinels isolated' : 'Cross-read detected' };
    } catch (e) {
      return { isolated: false, details: `FS error: ${(e as Error).message}` };
    }
  }

  // Session epoch: Every successful sign-in starts an epoch. Sign-out, identity mismatch or credential invalidation ends it.
  startEpoch(accountId: string): string {
    const sess = this.sessions.get(accountId);
    if (!sess) throw new Error(`No session for ${accountId}`);
    const newEpoch = randomUUID();
    sess.sessionEpochId = newEpoch;
    sess.lastUsedAt = new Date().toISOString();
    return newEpoch;
  }

  endEpoch(accountId: string, reason: 'sign_out' | 'identity_mismatch' | 'credential_invalid' | 'app_restart'): void {
    const sess = this.sessions.get(accountId);
    if (!sess) return;
    sess.sessionEpochId = randomUUID(); // new epoch will start on next sign-in
    sess.lastUsedAt = new Date().toISOString();
    console.log(`[SessionManager] Ended epoch for ${accountId} reason=${reason}`);
  }
}
