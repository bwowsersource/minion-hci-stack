import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { platformPackageName } from "./runtime";

// Forward slashes on every host: GNU tar (Git for Windows) treats `\` as an escape.
const join = posix.join;

const OS = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
// Apple Silicon's prebuilt package is `mac-arm64-metal`, not `mac-arm64`.
// Mirrors the name node-llama-cpp itself imports in
// `getPrebuiltBinariesPackageDirectoryForBuildOptions()`.
const PLATFORM_PREBUILD =
  OS === "mac" && process.arch === "arm64" ? "@node-llama-cpp/mac-arm64-metal" : `@node-llama-cpp/${OS}-${process.arch}`;
// The CPU prebuild plus the Vulkan one (picked at getLlama() time, falling back
// to CPU where there is no usable driver). CUDA (181M+) is left out; macOS has
// Metal in the base package, so it has no -vulkan variant and that entry is skipped.
const PREBUILDS = [PLATFORM_PREBUILD, `${PLATFORM_PREBUILD}-vulkan`];

const PACKAGE = "@bwowsersource/minion-hci-stack";

function closure(nodeModules: string, roots: string[]): string[] {
  const dirs = new Set<string>();
  const visit = (name: string) => {
    const dir = join(nodeModules, name);
    if (dirs.has(dir) || !existsSync(join(dir, "package.json"))) return;
    dirs.add(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      // Other platforms' packages are optionalDependencies; only ours are added explicitly.
      if (dep.startsWith("@node-llama-cpp/") || dep.startsWith(`${PACKAGE}-`)) continue;
      visit(dep);
    }
    if (name === "node-llama-cpp") for (const prebuild of PREBUILDS) visit(prebuild);
    if (name === PACKAGE) visit(platformPackageName());
  };
  for (const name of roots) visit(name);
  return [...dirs].sort();
}

/**
 * Creates `outFile` (replacing any existing one) holding the `node_modules/...`
 * closure of the stack for the build host: the package, its dependencies, this
 * machine's platform package (omnivoice binaries) and only the host's llama
 * prebuilds. `cwd` is the directory containing `node_modules`.
 */
export function packRuntime(outFile: string, cwd: string = process.cwd()): void {
  const nodeModules = "node_modules";
  const dirs = closure(nodeModules, [PACKAGE]);
  const has = (name: string) => dirs.includes(join(nodeModules, name));
  if (!has(PACKAGE)) throw new Error(`${PACKAGE} is not installed; run the install step before packing.`);
  if (!has("node-llama-cpp") || !has(PLATFORM_PREBUILD)) {
    throw new Error(
      `${PLATFORM_PREBUILD} is not installed, so the packaged app would have to build node-llama-cpp ` +
        "from source on first use. Run `bun install` with optional dependencies before packing.",
    );
  }
  if (!has(platformPackageName())) {
    throw new Error(`${platformPackageName()} is not installed, so the packaged app would ship without OmniVoice.`);
  }
  // -h: workspace/`file:` installs are symlinks; archive their contents.
  const result = spawnSync("tar", ["-chf", outFile, ...dirs], { stdio: "inherit", cwd });
  if (result.status !== 0) throw new Error(`tar exited with status ${result.status}`);
  console.log(`[minion-hci-stack] ${dirs.length} packages -> ${outFile}`);
}
