import { afterEach, describe, test } from "node:test";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../test/expect.ts";
import { TtsDiskCache } from "./ttsCache.ts";

const tmpDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prodash-tts-cache-"));
  tmpDirs.push(dir);
  return dir;
}

function wav(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TtsDiskCache", () => {
  test("caches by text and refreshes access order", () => {
    const cache = new TtsDiskCache(tempDir(), 3);
    cache.set("a", "", wav(1));
    cache.set("b", "", wav(2));
    cache.set("c", "", wav(3));
    expect(cache.get("a", "")?.wavBase64).toBe(Buffer.from([1]).toString("base64"));
    cache.set("d", "", wav(4)); // evicts b, the least recently accessed
    expect(cache.get("b", "")).toBeNull();
    expect(cache.get("a", "")).not.toBeNull();
    expect(cache.get("c", "")).not.toBeNull();
    expect(cache.get("d", "")).not.toBeNull();
    expect(cache.stats().size).toBe(3);
  });

  test("evicts the least recently accessed past maxEntries", () => {
    const cache = new TtsDiskCache(tempDir(), 2);
    cache.set("x", "", wav(1));
    cache.set("y", "", wav(2));
    cache.get("x", "");
    cache.set("z", "", wav(3));
    expect(cache.get("y", "")).toBeNull();
    expect(cache.get("x", "")).not.toBeNull();
    expect(cache.get("z", "")).not.toBeNull();
  });

  test("persists the index and restores LRU order", () => {
    const dir = tempDir();
    const first = new TtsDiskCache(dir, 3);
    first.set("a", "", wav(1));
    first.set("b", "", wav(2));
    first.set("c", "", wav(3));
    first.get("a", ""); // order is now b, c, a

    const second = new TtsDiskCache(dir, 3);
    expect(second.stats().entries.map((entry) => entry.key)).toEqual(["b", "c", "a"]);
    expect(second.get("c", "")?.wavBase64).toBe(Buffer.from([3]).toString("base64"));
  });

  test("fingerprint mismatch drops the stale variant", () => {
    const cache = new TtsDiskCache(tempDir(), 5);
    cache.set("hello", "female", wav(9));
    expect(cache.get("hello", "male")).toBeNull();
    expect(cache.get("hello", "female")).toBeNull(); // dropped by the mismatch
    cache.set("hello", "female", wav(9));
    expect(cache.get("hello", "female")?.wavBase64).toBe(Buffer.from([9]).toString("base64"));
  });

  test("a recording whose file disappeared is a cache miss", () => {
    const dir = tempDir();
    const cache = new TtsDiskCache(dir, 5);
    cache.set("a", "", wav(1));
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".wav")) unlinkSync(join(dir, file));
    }
    expect(cache.get("a", "")).toBeNull();
    expect(cache.stats().size).toBe(0);
  });

  test("clear empties the cache and its index", () => {
    const dir = tempDir();
    const cache = new TtsDiskCache(dir, 5);
    cache.set("a", "", wav(1));
    cache.set("b", "", wav(2));
    cache.clear();
    expect(cache.stats().size).toBe(0);
    expect(new TtsDiskCache(dir, 5).stats().size).toBe(0);
  });
});
