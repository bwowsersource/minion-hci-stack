/**
 * Builds the `omnivoice-tts` binaries for the host platform into
 * build/omnivoice/<variant>/ (stage-platform-packages.ts packages them):
 *   - Linux/Windows: `vulkan/` (Vulkan backend) and `cpu/` (fallback)
 *   - macOS:         `default/` (ggml enables Metal on its own)
 * each with the binary and its shared libs side by side (rpath is $ORIGIN /
 * @loader_path, DLLs sit next to the .exe).
 *
 * Why two builds on Linux/Windows: ggml's Vulkan shaders are compiled at build
 * time and embedded, so users need no SDK, but libggml-vulkan links the Vulkan
 * loader (libvulkan.so.1 / vulkan-1.dll), and a machine without it can't even
 * start that binary. The CPU build is the fallback for that and for GPU errors.
 *
 * Builds are portable (GGML_NATIVE=OFF): the CPU code must not assume the build
 * machine's instruction set. The Vulkan variant needs the Vulkan headers and
 * `glslc`; without them this fails rather than silently shipping CPU-only.
 * MINION_HCI_ALLOW_CPU_OMNIVOICE=1 is the explicit opt-out.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { whichSync } from "../packages/minion-hci-stack/src/which.ts";

export const REPO = "https://github.com/ServeurpersoCom/omnivoice.cpp.git";
const platform = process.platform;
const isWindows = platform === "win32";
const exe = isWindows ? "omnivoice-tts.exe" : "omnivoice-tts";
const OUT_DIR = join("build", "omnivoice");

type Variant = "vulkan" | "cpu" | "default";

function warn(message: string): void {
  console.warn(`[build-omnivoice] ${message}`);
}

function run(argv: string[], cwd?: string): void {
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`\`${argv.join(" ")}\` exited with ${result.status}`);
}

/**
 * Scratch dir for the cmake build. On Windows the default temp dir is both long
 * (the Vulkan shader-gen sub-build exceeds MAX_PATH, FTK1011) and rejected by
 * MSBuild (MSB8029), so use a short dir at the drive root.
 */
function makeWorkDir(): string {
  if (isWindows) {
    const root = join(`${process.env.SystemDrive || "C:"}\\`, "ovb");
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, "b"));
  }
  return mkdtempSync(join(tmpdir(), "omnivoice-build-"));
}

/** Finds the built executable anywhere under `dir` (multi-config generators nest it in Release/). */
function findBinary(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "CMakeFiles") continue;
      const found = findBinary(path);
      if (found) return found;
    } else if (entry.name === exe) {
      return path;
    }
  }
  return null;
}

/** Copies every shared lib in the build tree (ggml's land in subfolders) next to the binary. copyFileSync follows symlinks. */
function copyLibs(dir: string, targetDir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "CMakeFiles") copyLibs(path, targetDir);
    } else if (/\.(so(\.\d+)*|dylib|dll|metallib)$/.test(entry.name)) {
      copyFileSync(path, join(targetDir, entry.name));
    }
  }
}

/** Flag sets tried in order for one variant; the first that configures and builds wins. */
function flagSets(variant: Variant): string[][] {
  const portable = platform === "darwin" ? [] : ["-DGGML_NATIVE=OFF"];
  const gpu = variant === "vulkan" ? ["-DGGML_VULKAN=ON"] : [];
  // Windows: clang-cl builds the CPU kernels much faster than MSVC.
  const toolchains: string[][] = isWindows ? [["-T", "ClangCL"], []] : [[]];
  return toolchains.map((toolchain) => [...portable, ...gpu, ...toolchain]);
}

function buildVariant(src: string, variant: Variant, outDir: string): void {
  const build = join(src, `build-${variant}`);
  const rpathFlags = isWindows
    ? []
    : ["-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON", `-DCMAKE_INSTALL_RPATH=${platform === "darwin" ? "@loader_path" : "$ORIGIN"}`];
  const sets = flagSets(variant);
  for (const [i, flags] of sets.entries()) {
    console.log(`[build-omnivoice] ${variant}: configuring${flags.length ? ` (${flags.join(" ")})` : ""}`);
    try {
      run(["cmake", "-S", src, "-B", build, "-DCMAKE_BUILD_TYPE=Release", ...rpathFlags, ...flags]);
      run(["cmake", "--build", build, "--config", "Release", "-j", String(availableParallelism())]);
      break;
    } catch (err) {
      if (i === sets.length - 1) throw err;
      warn(`${variant}: that toolchain failed, trying the next.`);
      rmSync(build, { recursive: true, force: true });
    }
  }
  const binary = findBinary(build);
  if (!binary) throw new Error(`${variant}: build finished but ${exe} was not found`);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(binary, join(outDir, exe));
  chmodSync(join(outDir, exe), 0o755);
  copyLibs(build, outDir);
}

/**
 * What ggml's Vulkan backend needs to configure: the Vulkan headers/loader, glslc
 * to compile its shaders, and (Linux) the SPIRV-Headers package, which is
 * separate from libvulkan-dev.
 */
function hasVulkanBuildTools(): boolean {
  if (isWindows) {
    const sdk = process.env.VULKAN_SDK;
    return Boolean(sdk) && (Boolean(whichSync("glslc")) || existsSync(join(sdk!, "Bin", "glslc.exe")));
  }
  const hasPkg = (name: string) => spawnSync("pkg-config", ["--exists", name]).status === 0;
  const spirvHeaders = hasPkg("SPIRV-Headers") || existsSync("/usr/include/spirv/unified1/spirv.hpp");
  return hasPkg("vulkan") && spirvHeaders && Boolean(whichSync("glslc"));
}

export function buildOmniVoice(): void {
  for (const tool of ["git", "cmake"]) {
    if (!whichSync(tool)) throw new Error(`${tool} not found; it is needed to build omnivoice-tts.`);
  }
  const variants: Variant[] = platform === "darwin" ? ["default"] : ["vulkan", "cpu"];
  if (variants.includes("vulkan") && !hasVulkanBuildTools()) {
    const hint = isWindows
      ? "install the Vulkan SDK (https://vulkan.lunarg.com/sdk/home) so VULKAN_SDK is set"
      : "Ubuntu/Debian: sudo apt install libvulkan-dev glslc spirv-headers; Fedora: sudo dnf install vulkan-loader-devel glslc spirv-headers-devel";
    if (process.env.MINION_HCI_ALLOW_CPU_OMNIVOICE !== "1") {
      throw new Error(
        `Vulkan build tools not found, so this would ship a CPU-only OmniVoice (${hint}). ` +
          "To build CPU-only on purpose, set MINION_HCI_ALLOW_CPU_OMNIVOICE=1.",
      );
    }
    warn("Vulkan build tools not found; building CPU-only (MINION_HCI_ALLOW_CPU_OMNIVOICE=1).");
    variants.splice(variants.indexOf("vulkan"), 1);
  }

  const work = makeWorkDir();
  try {
    const src = join(work, "omnivoice.cpp");
    run(["git", "clone", "--depth", "1", "--recurse-submodules", "--shallow-submodules", REPO, src]);
    // Build into scratch and move into OUT_DIR only once every variant
    // succeeded, so a failed run never leaves a half-populated output.
    const built = join(work, "out");
    for (const variant of variants) buildVariant(src, variant, join(built, variant));
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    for (const variant of variants) {
      mkdirSync(join(OUT_DIR, variant), { recursive: true });
      for (const file of readdirSync(join(built, variant))) copyFileSync(join(built, variant, file), join(OUT_DIR, variant, file));
    }
    console.log(`[build-omnivoice] ${variants.join(" + ")} -> ${OUT_DIR}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) buildOmniVoice();
