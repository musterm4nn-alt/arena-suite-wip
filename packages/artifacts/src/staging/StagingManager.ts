import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ArtifactEncryption, type SealedBlobMeta } from '../encryption/ArtifactEncryption.js';
import { MimeSniffer } from '../mime/MimeSniffer.js';

/**
 * Artifact commit protocol per 10.3:
 * stage → hash/MIME sniff → encrypt to temp sealed blob → fsync → atomic rename → DB commit → remove plaintext staging file
 */

export interface StagedArtifact {
  stagingId: string;
  stagingPath: string;
  accountId: string;
  filename: string | null;
  mimeType: string | null;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

export class StagingManager {
  constructor(
    private stagingRoot: string,
    private sealedRoot: string,
    private archiveKey: Buffer,
  ) {}

  async stage(accountId: string, sourcePath: string, filename?: string | null): Promise<StagedArtifact> {
    await fs.promises.mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const stagingId = randomUUID();
    const stagingPath = path.join(this.stagingRoot, stagingId);

    await fs.promises.copyFile(sourcePath, stagingPath);
    const data = await fs.promises.readFile(stagingPath);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const mime = MimeSniffer.sniff(data);

    return {
      stagingId,
      stagingPath,
      accountId,
      filename: filename ?? null,
      mimeType: mime,
      byteLength: data.length,
      sha256,
      createdAt: new Date().toISOString(),
    };
  }

  async stageBuffer(accountId: string, buffer: Buffer, filename?: string | null): Promise<StagedArtifact> {
    await fs.promises.mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const stagingId = randomUUID();
    const stagingPath = path.join(this.stagingRoot, stagingId);
    await fs.promises.writeFile(stagingPath, buffer, { mode: 0o600 });

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const mime = MimeSniffer.sniff(buffer);

    return {
      stagingId,
      stagingPath,
      accountId,
      filename: filename ?? null,
      mimeType: mime,
      byteLength: buffer.length,
      sha256,
      createdAt: new Date().toISOString(),
    };
  }

  async seal(staged: StagedArtifact): Promise<{ sealedPath: string; meta: SealedBlobMeta }> {
    await fs.promises.mkdir(this.sealedRoot, { recursive: true, mode: 0o700 });
    const sealedPath = path.join(this.sealedRoot, staged.stagingId + '.enc');
    const meta = await ArtifactEncryption.seal(staged.stagingPath, sealedPath, this.archiveKey, {
      blob_id: staged.stagingId,
      account_id: staged.accountId,
      source_hash: staged.sha256,
      mime_type: staged.mimeType,
      original_length: staged.byteLength,
    });
    return { sealedPath, meta };
  }

  async commit(staged: StagedArtifact, sealedPath: string): Promise<void> {
    // DB commit would happen here in ArchiveService — after that, remove plaintext
    // For now, verify sealed exists then remove staging
    await fs.promises.access(sealedPath);
    await fs.promises.unlink(staged.stagingPath);
  }

  async cleanupOrphans(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const files = await fs.promises.readdir(this.stagingRoot);
      let cleaned = 0;
      const now = Date.now();
      for (const f of files) {
        const p = path.join(this.stagingRoot, f);
        try {
          const stat = await fs.promises.stat(p);
          if (now - stat.mtimeMs > maxAgeMs) {
            await fs.promises.unlink(p);
            cleaned++;
          }
        } catch {}
      }
      return cleaned;
    } catch {
      return 0;
    }
  }
}
