import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the stack keeps what it downloads or unpacks. Every field is optional:
 * a field that is left out is derived from `assetsDir`, which itself falls back
 * to $MINION_HCI_ASSETS_DIR and then to ~/.minion-hci-stack.
 */
export type StackConfig = {
  /** Root for everything below. */
  assetsDir?: string;
  /** Every model's weights, one subfolder per model: <modelsDir>/<name>/... Default <assetsDir>/models. */
  modelsDir?: string;
  /** Parent of the Needle / Whistle folders (<cactusModelsDir>/needle3, /whistle). Default: modelsDir. */
  cactusModelsDir?: string;
  /** OmniVoice voice profiles, TTS cache and a locally built `omnivoice-tts`. Default <assetsDir>/omnivoice. */
  omnivoiceDir?: string;
  /** Where a packaged build's runtime archive is unpacked. Default <assetsDir>/runtime. */
  runtimeDir?: string;
  /** The runtime archive shipped with a packaged build; unset means "resolve packages normally". */
  runtimeArchive?: string;
};

export const ASSETS_DIR_ENV = "MINION_HCI_ASSETS_DIR";

export type StackPaths = Required<Omit<StackConfig, "runtimeArchive">> & { runtimeArchive: string | null };

/** cactus-needle's `cacheDir` for one model; it adds its own revision folder below this. */
export function cactusCacheDir(model: "needle3" | "whistle"): string {
  return join(stackPaths().cactusModelsDir, model);
}

let configured: StackConfig = {};

/** Sets (merges into) the stack's locations. Call once at startup, before first use. */
export function configureStack(config: StackConfig): void {
  configured = { ...configured, ...config };
}

/** The effective locations: explicit option, else derived from `assetsDir`. */
export function stackPaths(): StackPaths {
  const assetsDir = configured.assetsDir ?? (process.env[ASSETS_DIR_ENV]?.trim() || join(homedir(), ".minion-hci-stack"));
  const modelsDir = configured.modelsDir ?? join(assetsDir, "models");
  return {
    assetsDir,
    modelsDir,
    cactusModelsDir: configured.cactusModelsDir ?? modelsDir,
    omnivoiceDir: configured.omnivoiceDir ?? join(assetsDir, "omnivoice"),
    runtimeDir: configured.runtimeDir ?? join(assetsDir, "runtime"),
    runtimeArchive: configured.runtimeArchive ?? null,
  };
}
