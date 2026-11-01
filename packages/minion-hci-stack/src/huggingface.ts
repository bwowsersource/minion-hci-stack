import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { stackPaths } from "./config";

export type HuggingfaceModelSpec = {
  slotId: string; // stable id for the data subdir default
  url: string; // full HF resolve URL for the pinned single-file artifact
  filename: string;
  subdir?: string; // defaults to slotId
};

/**
 * Generic "download a single HF file into the stack's models folder" unit,
 * extracted from the minion's original bespoke MinionRuntime so
 * 'golem' can reuse it once its real runtime lands. Scope matches what
 * MinionRuntime already did exactly — no multi-file support, no
 * resumable range-requests.
 */
export class HuggingfaceModelRuntime {
  private abortController: AbortController | null = null;

  constructor(private spec: HuggingfaceModelSpec) {}

  private get dir(): string {
    return join(stackPaths().modelsDir, this.spec.subdir ?? this.spec.slotId);
  }

  private get filePath(): string {
    return join(this.dir, this.spec.filename);
  }

  /** Absolute path to the persisted file on disk, if downloaded — for same-process backends (e.g. node-llama-cpp) that read it directly. */
  get localFilePath(): string {
    return this.filePath;
  }

  private get tmpPath(): string {
    return `${this.filePath}.part`;
  }

  isDownloaded(): boolean {
    return existsSync(this.filePath);
  }

  async download(onProgress: (progress: number) => void): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const abortController = new AbortController();
    this.abortController = abortController;
    try {
      const response = await fetch(this.spec.url, { signal: abortController.signal });
      if (!response.ok || !response.body) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const total = Number(response.headers.get("content-length") ?? 0);
      let loaded = 0;
      let lastEmit = 0;
      const writer = Bun.file(this.tmpPath).writer();
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
          loaded += value.byteLength;
          const now = Date.now();
          if (total > 0 && now - lastEmit > 200) {
            lastEmit = now;
            onProgress(Math.min(99, Math.round((loaded / total) * 100)));
          }
        }
      } finally {
        await writer.end();
      }
      rmSync(this.filePath, { force: true });
      renameSync(this.tmpPath, this.filePath);
      onProgress(100);
    } finally {
      this.abortController = null;
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
    rmSync(this.tmpPath, { force: true });
  }

  deleteFile(): void {
    this.cancel();
    rmSync(this.filePath, { force: true });
  }
}
