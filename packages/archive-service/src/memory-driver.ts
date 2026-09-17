/** In-memory driver: P0 spike, tests, and gate runs. Not for production. */
import type { ArchiveDriver, DriverStats, ObservationRow } from "./driver.js";
import { LATEST_VERSION } from "./migrations.js";

export class MemoryDriver implements ArchiveDriver {
  readonly name = "memory";
  private version = 0;
  private readonly rows = new Map<string, ObservationRow>();
  private readonly accounts = new Set<string>();
  private closed = false;

  async migrate(target: number): Promise<void> {
    this.assertOpen();
    if (target < this.version) {
      throw new Error(`migrations are forward-only (${this.version} -> ${target})`);
    }
    if (target > LATEST_VERSION) {
      throw new Error(`unknown migration target ${target} (latest ${LATEST_VERSION})`);
    }
    this.version = target;
  }

  async currentVersion(): Promise<number> {
    return this.version;
  }

  async insertObservation(row: ObservationRow): Promise<void> {
    this.assertOpen();
    this.requireMigrated();
    if (this.rows.has(row.id)) {
      throw new Error(`duplicate observation ${row.id}`);
    }
    this.rows.set(row.id, { ...row });
    this.accounts.add(row.account_id);
  }

  async getObservation(accountId: string, id: string): Promise<ObservationRow | null> {
    this.assertOpen();
    const row = this.rows.get(id);
    // Account scope enforced at the driver boundary (plan §5 deletion/account rules).
    if (!row || row.account_id !== accountId) return null;
    return { ...row };
  }

  async listObservations(
    accountId: string,
    limit: number,
    cursor: string | null,
  ): Promise<{ rows: ObservationRow[]; nextCursor: string | null }> {
    this.assertOpen();
    const sorted = [...this.rows.values()]
      .filter((r) => r.account_id === accountId)
      .sort((a, b) =>
        a.observed_at_ms !== b.observed_at_ms
          ? a.observed_at_ms - b.observed_at_ms
          : a.id < b.id
            ? -1
            : 1,
      );
    let start = 0;
    if (cursor !== null) {
      const idx = sorted.findIndex((r) => r.id === cursor);
      start = idx === -1 ? sorted.length : idx + 1;
    }
    const page = sorted.slice(start, start + limit);
    const last = page[page.length - 1];
    const hasMore = start + page.length < sorted.length;
    return {
      rows: page.map((r) => ({ ...r })),
      nextCursor: hasMore && last ? last.id : null,
    };
  }

  async stats(): Promise<DriverStats> {
    return { observations: this.rows.size, accounts: this.accounts.size };
  }

  async integrityCheck(): Promise<string[]> {
    const findings: string[] = [];
    for (const row of this.rows.values()) {
      if (!this.accounts.has(row.account_id)) {
        findings.push(`orphan observation ${row.id}`);
      }
    }
    return findings;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("driver closed");
  }

  private requireMigrated(): void {
    if (this.version < 1) throw new Error("driver not migrated (call migrate(1))");
  }
}
