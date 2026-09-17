/**
 * DownloadManager — account-bound staging and handoff (plan §4/§5).
 *
 * The initiating session determines the artifact account BEFORE file linkage.
 * Same filename/source URL in two accounts => two provenance records.
 */
import * as path from "node:path";

export interface DownloadHandoff {
  accountId: string;
  epochId: string | null;
  stagingPath: string;
  fileName: string;
  sourceUrlRef: string; // safe-ref JSON (never the raw signed URL)
  byteLength: number;
  startedAtMs: number;
}

export function stagingDir(userDataPath: string, accountId: string): string {
  return path.join(userDataPath, "staging", accountId);
}

/** Sanitize a remote filename into a safe staging leaf (no traversal). */
export function safeLeafName(remoteName: string, fallback = "download"): string {
  const base = path.basename(remoteName).replace(/[\0/\\]/g, "_").trim();
  const cleaned = base.replace(/^\.+/, "").slice(0, 180);
  return cleaned.length > 0 ? cleaned : fallback;
}
