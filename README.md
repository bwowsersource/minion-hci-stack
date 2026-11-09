# @bwowsersource/minion-hci-stack

The native inference stack behind prodash's minion, as one private package:

- **node-llama-cpp** — runs the minion GGUF (`MinionInferenceRuntime`)
- **cactus-needle** — the Needle and Whistle models (`CactusManager`)
- **omnivoice-tts** — text to speech (`OmniVoiceManager`)

These are the parts with platform-specific builds. `omnivoice-tts` binaries ship in
per-platform packages (`@bwowsersource/minion-hci-stack-<os>-<arch>`) listed as
`optionalDependencies`; the package manager installs only the one matching the
machine and `src/runtime.ts` finds it. node-llama-cpp's own prebuilt binaries
arrive the same way through its optional dependencies.

## Use

```ts
import { configureStack, CactusManager, OmniVoiceManager, MinionInferenceRuntime } from "@bwowsersource/minion-hci-stack";

configureStack({ assetsDir: "/path/to/data" }); // before first use
```

Types shared with a UI (no native imports) live under `@bwowsersource/minion-hci-stack/protocol/{cactus,omnivoice,mic}`.

## Runtime

Node.js **>= 22.18** only. The package is authored as TypeScript with explicit
`.ts` import specifiers and runs directly on Node's built-in type stripping — no
Bun, no loader, no build step for development. `tsc` compiles `dist/` (the `build`
script, run by `prepublishOnly`) with the specifiers rewritten to `.js`; the
published `exports` point at `dist/`, so consumers install plain ESM JavaScript.

The code sticks to `node:*` APIs. The tests use Node's built-in `node:test` runner
(`node --test`) with a small `expect` shim over `node:assert/strict`, and the
`scripts/` build tooling runs on Node too.

The demos import the package by name, so they need `dist/` built: `npm run demo`
and `npm run demo:scoring` build it first, then run the demo on Node.

## Where downloads go

`configureStack` takes `assetsDir` (or `$MINION_HCI_ASSETS_DIR`, else `~/.minion-hci-stack`); the rest default to subfolders of it and can each be overridden:

| option | default | holds |
| --- | --- | --- |
| `modelsDir` | `<assetsDir>/models` | all model weights, one folder per model (`minion/`, `omnivoice/`, `needle3/`, `whistle/`) |
| `cactusModelsDir` | `modelsDir` | parent of the `needle3/` and `whistle/` weight folders |
| `omnivoiceDir` | `<assetsDir>/omnivoice` | voice profiles, TTS cache, hand-built binary |
| `runtimeDir` | `<assetsDir>/runtime` | unpacked runtime archive (packaged apps) |
| `runtimeArchive` | none | tar produced by `packRuntime` (packaged apps) |

## Packaged apps

Bundlers such as Electrobun drop `node_modules`, so at build time call
`packRuntime(outFile)` from `@bwowsersource/minion-hci-stack/pack` and ship the tar;
at runtime set `runtimeArchive`/`runtimeDir` and the stack unpacks it once.

## Releasing

Publishing is driven by git hooks on each build machine, not CI, so bespoke or
embedded platforms can take part. Run `npm run githooks:install` once per clone.

- `pre-commit` bumps the patch version (and the matching `optionalDependencies`)
  when a commit touches `packages/minion-hci-stack/src` or `scripts/`.
- `pre-push` on `base` runs `scripts/publish-platform.sh`: it builds
  `omnivoice-tts` for *this* host, stages `@bwowsersource/minion-hci-stack-<os>-<arch>`
  and publishes it to GitHub Packages, then publishes the main package if that
  version isn't there yet. Push the same commit from each platform's machine to
  fill in every platform package. `SKIP_PUBLISH_HOOK=1 git push` skips it.
- A new platform: add `<os>-<arch>` to `optionalDependencies` in
  `packages/minion-hci-stack/package.json` before pushing from that machine.
- Auth: the script prompts you to paste a short-lived `write:packages` token (or
  reads `NPM_PUBLISH_TOKEN` from the environment) and exports it as
  `NODE_AUTH_TOKEN` for its run. Installing uses `NODE_AUTH_TOKEN`
  (`read:packages`, see `.npmrc`) exported in your session.
- Caching: an existing `build/omnivoice` is reused; pass `--force` to rebuild.

Local: `npm install && npm run build:package && npm test`;
`npm run publish -- --no-publish` builds and packs without publishing,
`npm run publish -- --force` rebuilds `omnivoice-tts` first.
