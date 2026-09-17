/**
 * @arena/artifacts — sealed artifact store (plan §10.3, §11.1).
 *
 * Commit protocol: stage -> hash/MIME sniff -> encrypt to temp sealed blob
 * (AES-256-GCM, per-blob nonce, AAD binds blob id + account + source hash) ->
 * fsync -> atomic rename -> DB commit (caller) -> remove plaintext staging.
 *
 * This package implements everything up to (and including) the atomic rename;
 * the DB commit stays in @arena/archive-service, the single SQLite writer.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SealedBlobMeta {
  blobId: string;
  accountId: string;
  byteLength: number;
  sha256: string;
  mime: string;
  sealedPath: string;
}

/** Tiny magic-number MIME sniff — never trusts extensions or page claims. */
export function sniffMime(bytes: Uint8Array): string {
  const h = (i: number): number => bytes[i] ?? -1;
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4e && h(3) === 0x47) return "image/png";
  if (h(0) === 0xff && h(1) === 0xd8 && h(2) === 0xff) return "image/jpeg";
  if (
    h(0) === 0x47 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x38
  )
    return "image/gif";
  if (
    h(0) === 0x25 && h(1) === 0x50 && h(2) === 0x44 && h(3) === 0x46
  )
    return "application/pdf";
  if (h(0) === 0x50 && h(1) === 0x4b && h(2) === 0x03 && h(3) === 0x04)
    return "application/zip";
  return "application/octet-stream";
}

function aadFor(blobId: string, accountId: string, sourceHash: string): Buffer {
  return Buffer.from(JSON.stringify({ blobId, accountId, sourceHash }), "utf8");
}

export interface SealOptions {
  blobId: string;
  accountId: string;
  /** Plaintext staging file; removed after successful seal. */
  stagingPath: string;
  /** Directory for sealed blobs (created if missing). */
  sealedDir: string;
  /** 32-byte archive data key (active key lives in archive service only). */
  dataKey: Uint8Array;
}

export async function sealBlob(opts: SealOptions): Promise<SealedBlobMeta> {
  if (opts.dataKey.byteLength !== 32) {
    throw new Error("dataKey must be 32 bytes (AES-256)");
  }
  const plaintext = await fs.readFile(opts.stagingPath);
  const sha256 = createHash("sha256").update(plaintext).digest("hex");
  const mime = sniffMime(plaintext);

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", opts.dataKey, nonce);
  cipher.setAAD(aadFor(opts.blobId, opts.accountId, sha256));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  await fs.mkdir(opts.sealedDir, { recursive: true, mode: 0o700 });
  const sealedPath = path.join(opts.sealedDir, `${opts.blobId}.sealed`);
  const tmpPath = `${sealedPath}.tmp-${process.pid}`;
  // Layout: magic(6) | version(1) | nonce(12) | tag(16) | ciphertext
  const out = Buffer.concat([
    Buffer.from("ARSEAL", "utf8"),
    Buffer.from([1]),
    nonce,
    tag,
    ciphertext,
  ]);
  const fh = await fs.open(tmpPath, "w", 0o600);
  try {
    await fh.writeFile(out);
    await fh.sync(); // fsync before rename
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, sealedPath);
  await fs.rm(opts.stagingPath, { force: true }); // plaintext staging removed
  return {
    blobId: opts.blobId,
    accountId: opts.accountId,
    byteLength: plaintext.byteLength,
    sha256,
    mime,
    sealedPath,
  };
}

export interface OpenOptions {
  sealedPath: string;
  blobId: string;
  accountId: string;
  sourceHash: string;
  dataKey: Uint8Array;
}

export async function openBlob(opts: OpenOptions): Promise<Uint8Array> {
  const raw = await fs.readFile(opts.sealedPath);
  if (raw.subarray(0, 6).toString("utf8") !== "ARSEAL" || raw[6] !== 1) {
    throw new Error("not a sealed v1 blob");
  }
  const nonce = raw.subarray(7, 19);
  const tag = raw.subarray(19, 35);
  const ciphertext = raw.subarray(35);
  const decipher = createDecipheriv("aes-256-gcm", opts.dataKey, nonce);
  decipher.setAAD(aadFor(opts.blobId, opts.accountId, opts.sourceHash));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const actual = createHash("sha256").update(plaintext).digest("hex");
  if (actual !== opts.sourceHash) {
    throw new Error("blob hash mismatch (wrong sourceHash or tampered blob)");
  }
  return new Uint8Array(plaintext);
}
