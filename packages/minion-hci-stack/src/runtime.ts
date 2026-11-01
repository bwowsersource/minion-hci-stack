import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { stackPaths } from "./config";

/**
 * Loads the stack's native packages (node-llama-cpp, cactus-needle) and finds
 * the per-platform omnivoice binaries.
 *
 * In development, and for any install that has a real node_modules, packages
 * resolve with a plain import. A packaged app can't carry node_modules (build
 * tools such as Electrobun's drop them), so it ships `runtimeArchive`, a tar of
 * the dependency closure (see pack.ts). That is unpacked once into `runtimeDir`
 * and imported from there, so the result doesn't depend on any node_modules
 * above the install.
 */

const loaded = new Map<string, Promise<unknown>>();
let unpacked: Promise<string | null> | null = null;

/** node-llama-cpp keeps its compiled llama.cpp build inside its own package tree. */
const LOCAL_BUILDS_SUBPATH = join("node_modules", "node-llama-cpp", "llama", "localBuilds");

/**
 * Moves node-llama-cpp's cached `localBuilds` tree from the previous unpack into
 * the new one. The archive never contains a local build (it's produced at
 * runtime), so without this a re-unpack deletes an expensive source build.
 */
function carryForwardLocalBuilds(fromDir: string, toDir: string): void {
  const from = join(fromDir, LOCAL_BUILDS_SUBPATH);
  const to = join(toDir, LOCAL_BUILDS_SUBPATH);
  if (!existsSync(from) || existsSync(to)) return;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  } catch {
    /* best effort: a failed move just means the next run rebuilds */
  }
}

async function unpackArchive(archive: string, dir: string): Promise<string> {
  const { size, mtimeMs } = statSync(archive);
  const stamp = `${size}:${Math.floor(mtimeMs)}`;
  const marker = join(dir, ".stamp");
  if (existsSync(marker) && readFileSync(marker, "utf-8") === stamp) return dir;

  // Extract beside the target and swap in, so a crash mid-unpack never leaves a
  // half-written tree that looks complete.
  const staging = `${dir}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const proc = Bun.spawn(["tar", "-xf", archive, "-C", staging], { stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`Could not unpack ${archive} (tar exited ${code}): ${stderr.trim()}`);
  }
  writeFileSync(join(staging, ".stamp"), stamp);
  carryForwardLocalBuilds(dir, staging);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return dir;
}

/**
 * The unpacked runtime directory, unpacking the archive first if needed. Resolves
 * null when there is nothing to unpack (no archive configured, or it's missing).
 */
export function runtimeDirReady(): Promise<string | null> {
  const { runtimeArchive, runtimeDir } = stackPaths();
  if (!runtimeArchive || !existsSync(runtimeArchive)) return Promise.resolve(null);
  unpacked ??= unpackArchive(runtimeArchive, runtimeDir).catch((error) => {
    unpacked = null; // retry on the next call instead of caching the failure
    throw error;
  });
  return unpacked;
}

/** Imports `name` from the unpacked runtime when there is one, else normally. */
export function loadRuntimeModule<T>(name: string): Promise<T> {
  let pending = loaded.get(name) as Promise<T> | undefined;
  if (!pending) {
    pending = (async () => {
      const dir = await runtimeDirReady();
      if (dir) return (await import(Bun.resolveSync(name, dir))) as T;
      return (await import(name)) as T;
    })();
    loaded.set(name, pending);
    pending.catch(() => loaded.delete(name));
  }
  return pending;
}

/** `<scope>/minion-hci-stack-<os>-<arch>`: the package holding this machine's omnivoice-tts builds. */
export function platformPackageName(platform: string = process.platform, arch: string = process.arch): string {
  return `@bwowsersource/minion-hci-stack-${platform}-${arch}`;
}

/** Best-first order of the build variants inside a platform package. */
export const OMNIVOICE_VARIANTS = ["vulkan", "default", "cpu"] as const;

/**
 * Paths of the `omnivoice-tts` binaries shipped for this machine, best first;
 * empty when the platform package isn't installed (unsupported platform, or
 * optional dependencies were skipped).
 */
export async function bundledOmniVoiceBinaries(): Promise<string[]> {
  const exeName = process.platform === "win32" ? "omnivoice-tts.exe" : "omnivoice-tts";
  const specifier = `${platformPackageName()}/package.json`;
  // The unpacked runtime first; otherwise an ordinary install, found from this
  // file or (when a host bundles this package) from the working directory.
  const roots = [await runtimeDirReady().catch(() => null), import.meta.dir, process.cwd()];
  for (const root of roots) {
    if (!root) continue;
    try {
      const manifest = Bun.resolveSync(specifier, root);
      return OMNIVOICE_VARIANTS.map((variant) => join(dirname(manifest), "omnivoice", variant, exeName)).filter(existsSync);
    } catch {
      /* not resolvable from here; try the next root */
    }
  }
  return [];
}
