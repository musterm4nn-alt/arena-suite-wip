/**
 * DownloadManager — account-bound staging and handoff per §4
 */

import { AccountId } from "@arena-archive/schema";
import { ArtifactStore } from "@arena-archive/artifacts";

export interface DownloadInfo {
  account_id: AccountId;
  url: string;
  filename: string;
  totalBytes: number;
  receivedBytes: number;
}

export class DownloadManager {
  private downloads = new Map<string, DownloadInfo>();

  constructor(private artifactStore: ArtifactStore) {}

  handleWillDownload(account_id: AccountId, url: string, filename: string): string {
    const id = `${account_id}-${Date.now()}-${filename}`;
    const info: DownloadInfo = {
      account_id,
      url,
      filename,
      totalBytes: 0,
      receivedBytes: 0,
    };
    this.downloads.set(id, info);
    console.log(`[DownloadManager] will-download account=${account_id} filename=${filename} url=${url} id=${id}`);
    // Initiating session determines artifact account before file linkage per §5
    return id;
  }

  updateProgress(id: string, received: number, total: number) {
    const info = this.downloads.get(id);
    if (!info) return;
    info.receivedBytes = received;
    info.totalBytes = total;
  }

  async completeDownload(id: string, data: Uint8Array): Promise<{ artifactId: string; sealedPath: string }> {
    const info = this.downloads.get(id);
    if (!info) throw new Error(`Download ${id} not found`);
    console.log(`[DownloadManager] complete account=${info.account_id} filename=${info.filename} bytes=${data.length}`);
    const staged = await this.artifactStore.stage(info.account_id, data, info.url);
    const sealed = await this.artifactStore.seal(staged);
    this.downloads.delete(id);
    return { artifactId: staged.id, sealedPath: sealed.sealed_blob_path };
  }
}
