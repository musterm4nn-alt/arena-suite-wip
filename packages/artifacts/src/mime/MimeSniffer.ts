/**
 * MIME sniffing — don't trust Content-Type alone
 */

const MAGIC: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
];

export class MimeSniffer {
  static sniff(buffer: Uint8Array, fallbackContentType?: string | null): string {
    for (const magic of MAGIC) {
      const off = magic.offset ?? 0;
      let match = true;
      for (let i = 0; i < magic.bytes.length; i++) {
        if (buffer[off + i] !== magic.bytes[i]) {
          match = false;
          break;
        }
      }
      if (match) return magic.mime;
    }
    if (fallbackContentType) {
      return fallbackContentType.split(';')[0].trim().toLowerCase();
    }
    return 'application/octet-stream';
  }
}
