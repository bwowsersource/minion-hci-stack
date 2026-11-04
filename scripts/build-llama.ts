/**
 * Fills the gap in node-llama-cpp's prebuilt binaries for the host: it ships GPU
 * (Vulkan/CUDA/Metal) builds only for some platforms, and elsewhere (e.g.
 * linux-arm64) it falls back to a CPU-only prebuilt with the warning "A prebuilt
 * binary was not found, falling back to using no GPU". When node-llama-cpp has no
 * Vulkan prebuilt for the host, this compiles one from source
 * (`node-llama-cpp source download --gpu vulkan`) and copies the resulting
 * localBuilds/<folder> into build/llama/localBuilds/ (stage-platform-packages.ts
 * packages it; llama.ts installs it into node-llama-cpp at runtime).
 *
 * Needs the Vulkan headers, `glslc` and cmake, like the omnivoice Vulkan build.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";

const PACKAGE_DIR = resolve("packages", "minion-hci-stack");
export const LLAMA_OUT_DIR = join("build", "llama");

function warn(message: string): void {
  console.warn(`[build-llama] ${message}`);
}

/** node-llama-cpp's own folder (hoisting differs between bun layouts, so resolve from the package). */
function nodeLlamaCppDir(): string {
  return dirname(Bun.resolveSync("node-llama-cpp/package.json", PACKAGE_DIR));
}

/** Prebuilt Vulkan packages node-llama-cpp lists, as `<os>-<arch>` keys (`linux-x64`, `win-x64`). */
function prebuiltVulkanTargets(): Set<string> {
  const manifest = JSON.parse(readFileSync(join(nodeLlamaCppDir(), "package.json"), "utf-8"));
  const targets = new Set<string>();
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    const match = /^@node-llama-cpp\/(.+)-vulkan$/.exec(name);
    if (match) targets.add(match[1]);
  }
  return targets;
}

function hasVulkanBuildTools(): boolean {
  if (!Bun.which("cmake")) return false;
  if (process.platform === "win32") return Boolean(process.env.VULKAN_SDK);
  const hasPkg = (name: string) => Bun.spawnSync(["pkg-config", "--exists", name]).exitCode === 0;
  const spirvHeaders = hasPkg("SPIRV-Headers") || existsSync("/usr/include/spirv/unified1/spirv.hpp");
  return hasPkg("vulkan") && spirvHeaders && Boolean(Bun.which("glslc"));
}

/** True when node-llama-cpp has no GPU prebuilt for this host, so one has to be compiled. */
export function llamaBuildNeeded(): boolean {
  if (process.platform === "darwin") return false; // Metal prebuilts cover both Mac archs
  const os = process.platform === "win32" ? "win" : "linux";
  return !prebuiltVulkanTargets().has(`${os}-${process.arch}`);
}

export function buildLlama(): void {
  if (!llamaBuildNeeded()) {
    console.log("[build-llama] node-llama-cpp ships a GPU prebuilt for this platform; nothing to build.");
    rmSync(LLAMA_OUT_DIR, { recursive: true, force: true });
    return;
  }
  if (!hasVulkanBuildTools()) {
    warn("Vulkan build tools (headers, glslc, cmake) not found; node-llama-cpp will run CPU-only here.");
    return;
  }
  const result = Bun.spawnSync(["bunx", "node-llama-cpp", "source", "download", "--gpu", "vulkan", "--noUsageExample"], {
    cwd: PACKAGE_DIR,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`node-llama-cpp source download exited with ${result.exitCode}`);

  const builds = join(nodeLlamaCppDir(), "llama", "localBuilds");
  const folders = existsSync(builds) ? readdirSync(builds).filter((name) => name.includes("vulkan")) : [];
  if (folders.length === 0) throw new Error(`build finished but no vulkan build was found in ${builds}`);
  rmSync(LLAMA_OUT_DIR, { recursive: true, force: true });
  mkdirSync(join(LLAMA_OUT_DIR, "localBuilds"), { recursive: true });
  for (const folder of folders) {
    // Only what node-llama-cpp loads: the addon and its libs, plus the marker that says the build is complete.
    const out = join(LLAMA_OUT_DIR, "localBuilds", folder);
    mkdirSync(out, { recursive: true });
    cpSync(join(builds, folder, "Release"), join(out, "Release"), { recursive: true, dereference: true });
    cpSync(join(builds, folder, "buildDone.status"), join(out, "buildDone.status"));
  }
  console.log(`[build-llama] ${folders.join(", ")} -> ${LLAMA_OUT_DIR}`);
}

if (import.meta.main) buildLlama();
