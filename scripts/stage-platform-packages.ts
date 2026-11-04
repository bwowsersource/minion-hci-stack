/**
 * Builds omnivoice-tts for the host (scripts/build-omnivoice.ts) and turns the
 * result into the publishable platform package for the host: packages/platform/<os>-<arch>/, named
 * @bwowsersource/minion-hci-stack-<os>-<arch>. `os`/`cpu` in its manifest make
 * package managers skip it on other machines, which is what lets the main
 * package list all of them as optionalDependencies.
 *
 * It also ships a node-llama-cpp GPU build for hosts where node-llama-cpp has no
 * GPU prebuilt (scripts/build-llama.ts), as the package's `llama/` folder.
 *
 * `--no-build` stages an existing build/omnivoice instead of rebuilding it (a
 * missing build/llama is still built when the host needs one).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildLlama, LLAMA_OUT_DIR, llamaBuildNeeded } from "./build-llama";
import { buildOmniVoice } from "./build-omnivoice";

const main = JSON.parse(readFileSync("packages/minion-hci-stack/package.json", "utf-8"));
const from = join("build", "omnivoice");
const noBuild = process.argv.includes("--no-build");
if (!noBuild) buildOmniVoice();
if (!noBuild || (llamaBuildNeeded() && !existsSync(LLAMA_OUT_DIR))) buildLlama();
if (!existsSync(from)) throw new Error(`${from} not found; run without --no-build.`);

const key = `${process.platform}-${process.arch}`;
const name = `${main.name}-${key}`;
if (!(name in main.optionalDependencies)) throw new Error(`${name} is not listed in optionalDependencies of ${main.name}.`);

const dir = join("packages", "platform", key);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync(from, join(dir, "omnivoice"), { recursive: true, dereference: true });
const hasLlama = existsSync(LLAMA_OUT_DIR);
if (hasLlama) cpSync(LLAMA_OUT_DIR, join(dir, "llama"), { recursive: true, dereference: true });
writeFileSync(
  join(dir, "package.json"),
  `${JSON.stringify(
    {
      name,
      version: main.version,
      description: `omnivoice-tts${hasLlama ? " and node-llama-cpp GPU" : ""} binaries for ${key}, used by ${main.name}.`,
      license: main.license,
      os: [process.platform],
      cpu: [process.arch],
      files: hasLlama ? ["omnivoice", "llama"] : ["omnivoice"],
      publishConfig: main.publishConfig,
      repository: main.repository,
    },
    null,
    2,
  )}\n`,
);
console.log(`[stage-platform-packages] ${name}@${main.version} -> ${dir}`);
