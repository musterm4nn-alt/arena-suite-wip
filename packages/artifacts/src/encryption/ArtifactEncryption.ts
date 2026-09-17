import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Large artifacts encrypted individually with AES-256-GCM per 11.1
 * Per-blob nonces and authenticated metadata containing blob id/account/source hash
 */

export interface SealedBlobMeta {
  blob_id: string;
  account_id: string;
  source_hash: string;
  nonce: string; // base64
  auth_tag: string; // base64
  original_byte_length: number;
  mime_type: string | null;
}

export class ArtifactEncryption {
  static async seal(
    plaintextPath: string,
    sealedPath: string,
    archiveKey: Buffer,
    meta: { blob_id: string; account_id: string; source_hash: string; mime_type: string | null; original_length: number }
  ): Promise<SealedBlobMeta> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', archiveKey, nonce);
    // AAD: authenticated metadata
    const aad = Buffer.from(JSON.stringify({ blob_id: meta.blob_id, account_id: meta.account_id, source_hash: meta.source_hash }));
    cipher.setAAD(aad);

    const plaintext = await fs.promises.readFile(plaintextPath);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    await fs.promises.mkdir(path.dirname(sealedPath), { recursive: true });
    // Write temp then atomic rename per transaction model
    const tmpPath = sealedPath + '.tmp.' + randomBytes(4).toString('hex');
    await fs.promises.writeFile(tmpPath, ciphertext);
    await fs.promises.rename(tmpPath, sealedPath);
    // fsync directory? best effort
    try {
      const dirHandle = await fs.promises.open(path.dirname(sealedPath), 'r');
      await dirHandle.sync();
      await dirHandle.close();
    } catch {}

    return {
      blob_id: meta.blob_id,
      account_id: meta.account_id,
      source_hash: meta.source_hash,
      nonce: nonce.toString('base64'),
      auth_tag: authTag.toString('base64'),
      original_byte_length: meta.original_length,
      mime_type: meta.mime_type,
    };
  }

  static async unseal(sealedPath: string, archiveKey: Buffer, meta: SealedBlobMeta): Promise<Buffer> {
    const nonce = Buffer.from(meta.nonce, 'base64');
    const authTag = Buffer.from(meta.auth_tag, 'base64');
    const aad = Buffer.from(JSON.stringify({ blob_id: meta.blob_id, account_id: meta.account_id, source_hash: meta.source_hash }));

    const ciphertext = await fs.promises.readFile(sealedPath);
    const decipher = createDecipheriv('aes-256-gcm', archiveKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
