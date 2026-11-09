import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { stackPaths } from "./config.ts";

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

  private readonly spec: HuggingfaceModelSpec;

  constructor(spec: HuggingfaceModelSpec) {
    this.spec = spec;
  }

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
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          loaded += chunk.length;
          const now = Date.now();
          if (total > 0 && now - lastEmit > 200) {
            lastEmit = now;
            onProgress(Math.min(99, Math.round((loaded / total) * 100)));
          }
          callback(null, chunk);
        },
      });
      // Streams to disk with backpressure instead of holding a whole model in memory.
      await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(this.tmpPath));
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
