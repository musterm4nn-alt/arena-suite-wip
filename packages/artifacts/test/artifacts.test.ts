import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openBlob, sealBlob, sniffMime } from "../src/index.js";

const A = "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0a";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "arena-art-"));
}

describe("artifacts", () => {
  it("seals then opens (round-trip), removes plaintext staging", async () => {
    const dir = await tmpDir();
    const staging = path.join(dir, "upload.png");
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("fake-png-body"),
    ]);
    await fs.writeFile(staging, png);
    const key = randomBytes(32);
    const meta = await sealBlob({
      blobId: "b1",
      accountId: A,
      stagingPath: staging,
      sealedDir: path.join(dir, "sealed"),
      dataKey: metaKey(key),
    });
    expect(meta.mime).toBe("image/png");
    expect(meta.byteLength).toBe(png.byteLength);
    // Plaintext staging removed:
    await expect(fs.stat(staging)).rejects.toThrow();
    const opened = await openBlob({
      sealedPath: meta.sealedPath,
      blobId: "b1",
      accountId: A,
      sourceHash: meta.sha256,
      dataKey: metaKey(key),
    });
    expect(Buffer.from(opened).equals(png)).toBe(true);
  });

  it("refuses to open under a different account (AAD binding)", async () => {
    const dir = await tmpDir();
    const staging = path.join(dir, "f.bin");
    await fs.writeFile(staging, Buffer.from("data"));
    const key = randomBytes(32);
    const meta = await sealBlob({
      blobId: "b2",
      accountId: A,
      stagingPath: staging,
      sealedDir: path.join(dir, "sealed"),
      dataKey: metaKey(key),
    });
    await expect(
      openBlob({
        sealedPath: meta.sealedPath,
        blobId: "b2",
        accountId: "01933b40-9c2a-7b1e-9c9b-2b6d6a2e8a0b",
        sourceHash: meta.sha256,
        dataKey: metaKey(key),
      }),
    ).rejects.toThrow();
  });

  it("sniffs MIME by magic bytes, not extension", () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(new Uint8Array([1, 2, 3, 4]))).toBe("application/octet-stream");
  });
});

function metaKey(k: Buffer): Uint8Array {
  return new Uint8Array(k.buffer, k.byteOffset, k.byteLength);
}
