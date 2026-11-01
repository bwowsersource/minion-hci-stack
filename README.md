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
embedded platforms can take part. Run `bun run githooks:install` once per clone.

- `pre-commit` bumps the patch version (and the matching `optionalDependencies`)
  when a commit touches `packages/minion-hci-stack/src` or `scripts/`.
- `pre-push` on `main` runs `scripts/publish-platform.sh`: it builds
  `omnivoice-tts` for *this* host, stages `@bwowsersource/minion-hci-stack-<os>-<arch>`
  and publishes it to GitHub Packages, then publishes the main package if that
  version isn't there yet. Push the same commit from each platform's machine to
  fill in every platform package. `SKIP_PUBLISH_HOOK=1 git push` skips it.
- A new platform: add `<os>-<arch>` to `optionalDependencies` in
  `packages/minion-hci-stack/package.json` before pushing from that machine.
- Auth: `NPM_PUBLISH_TOKEN` (a short-lived token with `write:packages`) from the
  environment or `./.env.local`; the script exports it as `NODE_AUTH_TOKEN` for
  its run. Installing uses `NODE_AUTH_TOKEN` (`read:packages`, see `.npmrc`)
  exported in your session.

Local: `bun install && bun run build && bun run test`;
`bun run publish:platform -- --no-publish` builds and packs without publishing.


# publishing to GitHub Packages
Publishing, per build machine:
1. Create a GitHub token with write:packages. Put NPM_PUBLISH_TOKEN=... in the environment or in minion-hci-stack/.env.local, which is gitignored.
2. The stack needs its own GitHub remote, bwowsersource/minion-hci-stack. It has no remote yet. Pushing to main is what triggers the publish hook.
3. Run bun run githooks:install once per clone.
4. Run git push origin main. The pre-push hook builds omnivoice for that machine and publishes @bwowsersource/minion-hci-stack-<os>-<arch>. It also publishes the main package if that version isn't on the registry yet.
5. Repeat the push from each platform's machine, and add the platform to optionalDependencies first if it's new.

You can also run bun run publish:platform by hand, or bun run publish:platform -- --no-publish to build and pack only.
