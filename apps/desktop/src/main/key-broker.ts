/**
 * Key unwrap broker (plan §4, §11.1).
 *
 * The random 256-bit archive key is wrapped by macOS Keychain-backed storage.
 * At unlock time the main process briefly unwraps it, transfers it to the
 * archive service (utilityProcess), then DROPS its copy. This transient
 * exposure is explicit in the threat model; no key is ever written to
 * ordinary app files.
 *
 * P0: interface + guarded stub. Production implementation uses node-keytar
 * (or Electron safeStorage) on macOS only.
 */

export interface WrappedKey {
  version: 1;
  /** Keychain service/account locator — not key material. */
  locator: string;
  createdAtMs: number;
}

export interface KeyBroker {
  /** True when a wrapped key exists for this app identity. */
  hasWrappedKey(): Promise<boolean>;
  /** Generate + wrap a new random archive key. Returns the locator only. */
  generate(): Promise<WrappedKey>;
  /**
   * Briefly unwrap into memory for transfer to the archive service.
   * Callers MUST zero the returned buffer after transfer.
   */
  unwrapTransient(): Promise<Uint8Array>;
}

export function zeroBytes(buf: Uint8Array): void {
  buf.fill(0);
}

/** Test/P0 stub — refuses production use outside explicit test mode. */
export class StubKeyBroker implements KeyBroker {
  private wrapped: WrappedKey | null = null;
  private readonly material = new Map<string, Uint8Array>();

  async hasWrappedKey(): Promise<boolean> {
    return this.wrapped !== null;
  }

  async generate(): Promise<WrappedKey> {
    if (process.env["ARENA_ALLOW_STUB_KEYS"] !== "1") {
      throw new Error("stub key broker is test-only (ARENA_ALLOW_STUB_KEYS=1)");
    }
    const { randomBytes } = await import("node:crypto");
    const locator = `stub-${randomBytes(8).toString("hex")}`;
    this.wrapped = { version: 1, locator, createdAtMs: Date.now() };
    this.material.set(locator, new Uint8Array(randomBytes(32)));
    return { ...this.wrapped };
  }

  async unwrapTransient(): Promise<Uint8Array> {
    if (!this.wrapped) throw new Error("no wrapped key");
    const m = this.material.get(this.wrapped.locator);
    if (!m) throw new Error("key material missing");
    return Uint8Array.from(m);
  }
}
