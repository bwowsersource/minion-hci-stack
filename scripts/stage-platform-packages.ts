/**
 * Builds omnivoice-tts for the host (scripts/build-omnivoice.ts) and turns the
 * result into the publishable platform package for the host: packages/platform/<os>-<arch>/, named
 * @bwowsersource/minion-hci-stack-<os>-<arch>. `os`/`cpu` in its manifest make
 * package managers skip it on other machines, which is what lets the main
 * package list all of them as optionalDependencies.
 *
 * `--no-build` stages an existing build/omnivoice instead of rebuilding.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildOmniVoice } from "./build-omnivoice";

const main = JSON.parse(readFileSync("packages/minion-hci-stack/package.json", "utf-8"));
const from = join("build", "omnivoice");
if (!process.argv.includes("--no-build")) buildOmniVoice();
if (!existsSync(from)) throw new Error(`${from} not found; run without --no-build.`);

const key = `${process.platform}-${process.arch}`;
const name = `${main.name}-${key}`;
if (!(name in main.optionalDependencies)) throw new Error(`${name} is not listed in optionalDependencies of ${main.name}.`);

const dir = join("packages", "platform", key);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync(from, join(dir, "omnivoice"), { recursive: true, dereference: true });
writeFileSync(
  join(dir, "package.json"),
  `${JSON.stringify(
    {
      name,
      version: main.version,
      description: `omnivoice-tts binaries for ${key}, used by ${main.name}.`,
      license: main.license,
      os: [process.platform],
      cpu: [process.arch],
      files: ["omnivoice"],
      publishConfig: main.publishConfig,
      repository: main.repository,
    },
    null,
    2,
  )}\n`,
);
console.log(`[stage-platform-packages] ${name}@${main.version} -> ${dir}`);
