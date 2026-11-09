// A bounded on-disk cache for synthesized recordings, keyed by the text that
// produced them. Every get/set refreshes the entry's last-access timestamp;
// once there are more than `maxEntries`, the least recently accessed recording
// is deleted. The key is the text itself — a `fingerprint` (the voice settings)
// is stored alongside each entry but is NOT part of the key: when the same text
// is requested in a different voice, the stale variant is dropped and the miss
// regenerates, so a text cache never returns audio in the wrong voice.
//
// The index (`index.json`) is rewritten atomically after every access so the
// last-access timestamps and the LRU order survive restarts.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type CacheEntry = { fingerprint: string; file: string; bytes: number; lastAccess: number };

export type TtsCacheHit = { wavBase64: string; bytes: number; lastAccess: number };

export type TtsCacheStats = {
  size: number;
  maxEntries: number;
  /** Oldest access first. */
  entries: { key: string; bytes: number; lastAccess: number }[];
};

export class TtsDiskCache {
  private readonly entries = new Map<string, CacheEntry>();
  private loaded = false;

  private readonly dir: string;
  private readonly maxEntries: number;

  constructor(dir: string, maxEntries = 100) {
    this.dir = dir;
    this.maxEntries = maxEntries;
  }

  private get indexPath(): string {
    return join(this.dir, "index.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as {
        entries?: { key: string; fingerprint?: string; file: string; bytes?: number; lastAccess?: number }[];
      };
      for (const entry of parsed.entries ?? []) {
        if (typeof entry.key !== "string" || typeof entry.file !== "string") continue;
        this.entries.set(entry.key, {
          fingerprint: entry.fingerprint ?? "",
          file: entry.file,
          bytes: entry.bytes ?? 0,
          lastAccess: entry.lastAccess ?? 0,
        });
      }
      // Re-insert oldest-first so the Map's order doubles as the LRU order.
      const ordered = [...this.entries.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      this.entries.clear();
      for (const [key, entry] of ordered) this.entries.set(key, entry);
    } catch {
      // No cache yet (or an unreadable index): start empty.
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const entries = [...this.entries.entries()].map(([key, entry]) => ({ key, ...entry }));
      const tmp = `${this.indexPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2));
      renameSync(tmp, this.indexPath);
    } catch (err) {
      console.error(`[tts-cache] could not write the index: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    try {
      unlinkSync(join(this.dir, entry.file));
    } catch {
      // Already gone.
    }
  }

  /** Reads the cached WAV for `key`, refreshing its access time. */
  get(key: string, fingerprint: string): TtsCacheHit | null {
    this.load();
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) {
      // Same text, different voice: drop the stale recording and regenerate.
      this.remove(key);
      this.save();
      return null;
    }
    const path = join(this.dir, entry.file);
    if (!existsSync(path)) {
      this.remove(key);
      this.save();
      return null;
    }
    entry.lastAccess = Date.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.save();
    return { wavBase64: readFileSync(path).toString("base64"), bytes: entry.bytes, lastAccess: entry.lastAccess };
  }

  /** Stores a fresh WAV for `key`, replacing any previous variant. */
  set(key: string, fingerprint: string, wavBytes: Uint8Array): void {
    this.load();
    this.remove(key);
    const file = `${Number(process.hrtime.bigint() % 0xffffffffn).toString(36)}-${Date.now().toString(36)}.wav`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, file), wavBytes);
    } catch (err) {
      console.error(`[tts-cache] could not write a recording: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.entries.set(key, { fingerprint, file, bytes: wavBytes.length, lastAccess: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.save();
  }

  stats(): TtsCacheStats {
    this.load();
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      entries: [...this.entries.entries()].map(([key, entry]) => ({ key, bytes: entry.bytes, lastAccess: entry.lastAccess })),
    };
  }

  clear(): void {
    this.load();
    for (const key of [...this.entries.keys()]) this.remove(key);
    this.save();
  }
}
