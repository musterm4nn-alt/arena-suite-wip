import { KeychainBroker } from '@arena/security';

/**
 * Key unwrap broker — transient only (section 4)
 * Main process may briefly unwrap archive key through Keychain-backed broker at unlock time,
 * transfers it to archive service, then drops its copy. This transient exposure is explicitly part of threat model;
 * no key is written to ordinary app files.
 */

export class KeyBroker {
  private activeKey: Buffer | null = null;
  private unlockedAt: string | null = null;

  async unlock(wrappingKey: Buffer): Promise<Buffer> {
    const wrapped = await KeychainBroker.loadWrappedKey();
    if (!wrapped) {
      throw new Error('No wrapped key found — first run?');
    }
    const { key, drop } = KeychainBroker.transientUnwrapForTransfer(wrapped, wrappingKey);
    // Keep briefly for transfer
    this.activeKey = key;
    this.unlockedAt = new Date().toISOString();
    console.log(`[KeyBroker] Unlocked at ${this.unlockedAt} — transient`);

    // Simulate transfer to archive service
    // In real: send via MessagePort to utilityProcess, then drop
    // Here we return copy and schedule drop
    const copy = Buffer.from(key);

    // Drop after short delay — transient exposure
    setTimeout(() => {
      this.drop();
      drop();
    }, 5000);

    return copy;
  }

  drop(): void {
    if (this.activeKey) {
      this.activeKey.fill(0);
      this.activeKey = null;
      this.unlockedAt = null;
      console.log('[KeyBroker] Dropped active key copy');
    }
  }

  isUnlocked(): boolean {
    return this.activeKey !== null;
  }

  // For diagnostics — never expose key
  getStatus(): { unlocked: boolean; unlockedAt: string | null } {
    return { unlocked: this.isUnlocked(), unlockedAt: this.unlockedAt };
  }
}
