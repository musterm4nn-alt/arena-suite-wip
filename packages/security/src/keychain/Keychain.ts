import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Key handling per section 11.1
 * - Generate random 256-bit archive key
 * - Protect wrapped key with macOS Keychain-backed storage (simulated via OS keychain or file with 0600 for Linux dev)
 * - Keep active key in archive service only while unlocked
 * - Never claim Chromium partition directories are SQLCipher-protected
 */

export interface WrappedKey {
  wrapped_at: string;
  keychain_service: string;
  nonce: string;
  ciphertext: string; // base64
  auth_tag: string; // base64
}

export class KeychainBroker {
  private static SERVICE = 'com.arena.archive.key';

  /**
   * On macOS, this would use keychain via node-keytar or Electron safeStorage.
   * For cross-platform dev, we simulate with file + 0600 perms + optional safeStorage.
   */
  static generateArchiveKey(): Buffer {
    return randomBytes(32); // 256-bit
  }

  static wrapKey(archiveKey: Buffer, wrappingKey: Buffer): WrappedKey {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(archiveKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      wrapped_at: new Date().toISOString(),
      keychain_service: this.SERVICE,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      auth_tag: authTag.toString('base64'),
    };
  }

  static unwrapKey(wrapped: WrappedKey, wrappingKey: Buffer): Buffer {
    const nonce = Buffer.from(wrapped.nonce, 'base64');
    const ciphertext = Buffer.from(wrapped.ciphertext, 'base64');
    const authTag = Buffer.from(wrapped.auth_tag, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Simulated secure storage path for dev (on macOS would be Keychain)
   */
  static getSecureStoragePath(): string {
    const base = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ArenaArchive')
      : path.join(os.homedir(), '.config', 'arena-archive');
    return path.join(base, 'keychain.json');
  }

  static async storeWrappedKey(wrapped: WrappedKey): Promise<void> {
    const filePath = this.getSecureStoragePath();
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(filePath, JSON.stringify(wrapped, null, 2), { mode: 0o600 });
  }

  static async loadWrappedKey(): Promise<WrappedKey | null> {
    try {
      const filePath = this.getSecureStoragePath();
      const data = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(data) as WrappedKey;
    } catch {
      return null;
    }
  }

  /**
   * Transient broker: main process briefly unwraps, transfers to archive service, then drops copy.
   */
  static transientUnwrapForTransfer(wrapped: WrappedKey, wrappingKey: Buffer): { key: Buffer; drop: () => void } {
    const key = this.unwrapKey(wrapped, wrappingKey);
    let dropped = false;
    return {
      key,
      drop: () => {
        if (!dropped) {
          key.fill(0);
          dropped = true;
        }
      },
    };
  }
}
