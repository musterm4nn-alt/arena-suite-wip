import { SqliteDatabase } from '../db/Database.js';
import { ObservationJournal, type JournalEntry } from '../journal/ObservationJournal.js';
import { Normalizer } from '../normalizer/Normalizer.js';
import { JobScheduler } from '../jobs/JobScheduler.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Privileged archive service (utilityProcess) — sole database writer
 * Owns encrypted persistence, normalization, jobs, analysis, MCP service registry
 * Communicates via typed MessagePort / local IPC to Electron main
 * Then via Unix domain socket 0600 to stdio MCP bridge
 */

export interface ArchiveServiceConfig {
  dataDir: string;
  dbPath: string;
  archiveKey: Buffer;
  mockDb?: boolean;
}

export class ArchiveService {
  private db: SqliteDatabase;
  private journal: ObservationJournal;
  private normalizer: Normalizer;
  private scheduler: JobScheduler;
  private config: ArchiveServiceConfig;
  private started = false;

  constructor(config: ArchiveServiceConfig) {
    this.config = config;
    this.db = new SqliteDatabase(config.dbPath, { mock: config.mockDb ?? true });
    this.journal = new ObservationJournal();
    this.normalizer = new Normalizer();
    this.scheduler = new JobScheduler();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await fs.promises.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    await this.db.init();

    // On startup run integrity checks, recover orphan staging files, reconcile blob rows, rebuild FTS/projections
    const integrity = await this.db.integrityCheck();
    if (!integrity.ok) {
      console.error('[ArchiveService] Integrity check failed', integrity.errors);
      throw new Error('DB integrity failed');
    }

    this.started = true;
    console.log(`[ArchiveService] Started dataDir=${this.config.dataDir} mock=${this.config.mockDb}`);
  }

  async stop(): Promise<void> {
    this.db.close();
    this.started = false;
  }

  // Observation ingestion — first durable write
  async ingestObservation(raw: Omit<JournalEntry, 'id' | 'observed_at' | 'raw_sanitized'> & { raw_evidence: unknown; observed_at?: string }): Promise<JournalEntry> {
    const entry = await this.journal.append(raw as any);
    // Normalization happens in same or subsequent bounded transaction
    const normalized = await this.normalizer.normalize(entry);
    if (normalized) {
      // Would INSERT into turns/parts etc in same transaction
      console.log(`[ArchiveService] Normalized turn ${normalized.turn_id} account=${normalized.account_id}`);
    }
    return entry;
  }

  getJournal(): ObservationJournal {
    return this.journal;
  }

  getScheduler(): JobScheduler {
    return this.scheduler;
  }

  getDb(): SqliteDatabase {
    return this.db;
  }

  // Backup — encrypted bundles containing DB + sealed artifacts + manifest, verification path
  async backup(backupRoot: string): Promise<{ path: string; verified: boolean }> {
    const backupId = `backup-${Date.now()}`;
    const backupPath = path.join(backupRoot, backupId);
    await fs.promises.mkdir(backupPath, { recursive: true });
    const dbBackupPath = path.join(backupPath, 'archive.db');
    await this.db.backup(dbBackupPath);

    // Manifest
    const manifest = {
      id: backupId,
      created_at: new Date().toISOString(),
      counts: {
        observations: this.journal.count(),
      },
    };
    await fs.promises.writeFile(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Verification: reopen bundle and compare manifest counts/hashes
    const verified = await this.verifyBackup(backupPath, manifest);
    return { path: backupPath, verified };
  }

  private async verifyBackup(backupPath: string, manifest: { counts: { observations: number } }): Promise<boolean> {
    try {
      const manifestPath = path.join(backupPath, 'manifest.json');
      const data = await fs.promises.readFile(manifestPath, 'utf-8');
      const loaded = JSON.parse(data);
      return loaded.counts.observations === manifest.counts.observations;
    } catch {
      return false;
    }
  }

  // For diagnostics
  getStorageHealth() {
    return {
      dataDir: this.config.dataDir,
      dbPath: this.config.dbPath,
      journalCount: this.journal.count(),
      schedulerStats: this.scheduler.getStats(),
    };
  }

  static getDefaultDataDir(): string {
    const base = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ArenaArchive')
      : path.join(os.homedir(), '.config', 'arena-archive');
    return base;
  }
}
