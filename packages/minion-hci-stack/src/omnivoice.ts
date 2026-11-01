import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { base64ToFloat32 } from "./protocol/cactus";
import {
  OMNIVOICE_GGUF_REPO,
  OMNIVOICE_WEIGHTS,
  buildTtsArgs,
  decodeWav,
  encodeWav16,
  hashString,
  omniVoiceFingerprint,
  shouldReplaceVoiceReference,
  voiceProfileFit,
  voiceProfileKey,
} from "./protocol/omnivoice";
import type { OmniVoiceProgressMessage, OmniVoiceRequest, OmniVoiceResponse } from "./protocol/omnivoice";
import { stackPaths } from "./config";
import { HuggingfaceModelRuntime } from "./huggingface";
import { TtsDiskCache } from "./ttsCache";
import { bundledOmniVoiceBinaries } from "./runtime";

// Backs the "OmniVoice" example tab with omnivoice.cpp, a C++/GGML port of
// k2-fsa/OmniVoice. The two GGUF weight files download into the stack's models
// folder (see config.ts) on first use; the `omnivoice-tts` binary is found, in order, at
//   1. $MINION_HCI_OMNIVOICE_COMMAND (a full command, whitespace-separated)
//   2. the binaries in this machine's platform package
//      (@bwowsersource/minion-hci-stack-<os>-<arch>): the Vulkan build first, then the CPU build
//   3. <omnivoiceDir>/omnivoice-tts[.exe]   (a hand-built copy)
//   4. `omnivoice-tts` on PATH
// Shipped builds rank above the local one so a stale CPU-only build can't shadow the GPU build. If a candidate fails (no Vulkan
// loader, GPU error), the next one is tried.

export const OMNIVOICE_COMMAND_ENV = "MINION_HCI_OMNIVOICE_COMMAND";

// How many synthesized recordings to keep cached: the most recently accessed
// 100. The cache key is the text itself (see ttsCache.ts).
const TTS_CACHE_MAX_ENTRIES = 100;

/**
 * The persisted voice-clone reference for one voice-profile preference: the
 * customization tags (`instruct`) form the key, and each profile keeps exactly
 * one reference recording — the one closest to the ideal 10–15 s window. Once a
 * recording lands inside that window it is locked in place.
 */
type VoiceProfileReference = {
  key: string;
  tags: string;
  text: string;
  sampleRate: number;
  durationSeconds: number;
  ideal: boolean;
};

const BUILD_HINT = (dir: string) =>
  process.platform === "win32"
    ? `omnivoice-tts was not found. Build it once (needs git, cmake and Visual Studio Build Tools with "Desktop development with C++"):\n` +
      `  git clone --recurse-submodules https://github.com/ServeurpersoCom/omnivoice.cpp.git\n` +
      `  cd omnivoice.cpp && cmake -S . -B build && cmake --build build --config Release   # or buildvulkan.cmd / buildcuda.cmd\n` +
      `then copy omnivoice-tts.exe and the .dll files from build\\ (Release\\ or bin\\Release\\) to ${dir} (or put it on PATH, or set ${OMNIVOICE_COMMAND_ENV}).\n` +
      `Or install the @bwowsersource/minion-hci-stack-win32-x64 package, which ships prebuilt binaries.`
    : `omnivoice-tts was not found. Build it once (needs git, cmake and a C++17 compiler):\n` +
      `  git clone --recurse-submodules https://github.com/ServeurpersoCom/omnivoice.cpp.git\n` +
      `  cd omnivoice.cpp && ./buildcpu.sh   # or buildcuda.sh / buildvulkan.sh\n` +
      `then copy build/omnivoice-tts to ${dir} (or put it on PATH, or set ${OMNIVOICE_COMMAND_ENV}).`;

export class OmniVoiceManager {
  private current: ReturnType<typeof Bun.spawn> | null = null;
  private cancelled = false;
  private readonly weights;
  private readonly ttsCache: TtsDiskCache;
  /** Loaded voice profiles, keyed by `voiceProfileKey`; null means "none yet". */
  private readonly voiceProfiles = new Map<string, VoiceProfileReference | null>();

  constructor(
    private readonly sendProgress: (message: OmniVoiceProgressMessage) => void,
  ) {
    this.ttsCache = new TtsDiskCache(join(stackPaths().omnivoiceDir, "tts-cache"), TTS_CACHE_MAX_ENTRIES);
    this.weights = OMNIVOICE_WEIGHTS.map((w) => ({
      filename: w.filename,
      runtime: new HuggingfaceModelRuntime({
        slotId: w.slotId,
        subdir: "omnivoice",
        filename: w.filename,
        url: `${OMNIVOICE_GGUF_REPO}/${w.filename}`,
      }),
    }));
  }

  private get binDir(): string {
    return stackPaths().omnivoiceDir;
  }

  private async resolveCommands(): Promise<string[][]> {
    const override = process.env[OMNIVOICE_COMMAND_ENV]?.trim();
    if (override) return [override.split(/\s+/)];
    const commands = (await bundledOmniVoiceBinaries()).map((path) => [path]);
    const local = join(this.binDir, process.platform === "win32" ? "omnivoice-tts.exe" : "omnivoice-tts");
    if (existsSync(local)) commands.push([local]);
    const onPath = Bun.which("omnivoice-tts");
    if (onPath) commands.push([onPath]);
    return commands;
  }

  /** Downloads any missing TTS weight files. Idempotent (skips present files). */
  async downloadModels(): Promise<void> {
    await this.ensureWeights();
  }

  private async ensureWeights(): Promise<void> {
    for (const { filename, runtime } of this.weights) {
      if (runtime.isDownloaded()) continue;
      await runtime.download((percentage) => this.sendProgress({ file: filename, percentage }));
    }
  }

  private voiceProfileDir(): string {
    return join(this.binDir, "voice-profiles");
  }

  private voiceProfilePaths(key: string): { json: string; pcm: string } {
    const hash = hashString(key);
    const dir = this.voiceProfileDir();
    return { json: join(dir, `${hash}.json`), pcm: join(dir, `${hash}.pcm`) };
  }

  /** The stored reference for a profile, reading it from disk on first use. */
  private loadVoiceProfile(key: string): VoiceProfileReference | null {
    if (this.voiceProfiles.has(key)) return this.voiceProfiles.get(key) ?? null;
    let value: VoiceProfileReference | null = null;
    try {
      const { json } = this.voiceProfilePaths(key);
      if (existsSync(json)) {
        const parsed = JSON.parse(readFileSync(json, "utf8")) as Partial<VoiceProfileReference>;
        if (parsed.text && parsed.sampleRate && parsed.durationSeconds) {
          value = {
            key,
            tags: parsed.tags ?? "",
            text: parsed.text,
            sampleRate: parsed.sampleRate,
            durationSeconds: parsed.durationSeconds,
            ideal: parsed.ideal === true,
          };
        }
      }
    } catch (err) {
      console.warn(`[omnivoice] failed to read voice profile "${key}": ${String(err)}`);
    }
    this.voiceProfiles.set(key, value);
    return value;
  }

  /** Raw Float32 LE reference samples as base64, ready for `refPcm`. */
  private readVoiceProfilePcm(key: string): string | null {
    try {
      const { pcm } = this.voiceProfilePaths(key);
      return existsSync(pcm) ? readFileSync(pcm).toString("base64") : null;
    } catch {
      return null;
    }
  }

  private saveVoiceProfile(
    key: string,
    tags: string,
    samples: Float32Array,
    sampleRate: number,
    text: string,
    durationSeconds: number,
    ideal: boolean,
  ): void {
    mkdirSync(this.voiceProfileDir(), { recursive: true });
    const { json, pcm } = this.voiceProfilePaths(key);
    writeFileSync(pcm, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    const meta: VoiceProfileReference = { key, tags, text, sampleRate, durationSeconds, ideal };
    writeFileSync(json, JSON.stringify(meta, null, 2));
    this.voiceProfiles.set(key, meta);
  }

  /**
   * Offers a freshly generated recording as the reference for `key`. Keeps the
   * clip closest to the ideal 10–15 s window; once one lands inside that window
   * the profile is locked and later recordings are ignored.
   */
  private considerVoiceProfile(key: string, tags: string, wavBytes: Uint8Array, text: string): void {
    const current = this.loadVoiceProfile(key);
    if (current?.ideal) return;
    const decoded = decodeWav(wavBytes);
    if (!decoded || decoded.samples.length === 0 || decoded.sampleRate <= 0) return;
    const durationSeconds = decoded.samples.length / decoded.sampleRate;
    if (!shouldReplaceVoiceReference(current?.durationSeconds ?? null, durationSeconds)) return;
    const ideal = voiceProfileFit(durationSeconds) === 0;
    try {
      this.saveVoiceProfile(key, tags, decoded.samples, decoded.sampleRate, text, durationSeconds, ideal);
      console.log(
        `[omnivoice] voice profile ${ideal ? "locked" : "updated"} "${tags || "auto"}" (${durationSeconds.toFixed(2)}s)`,
      );
    } catch (err) {
      console.warn(`[omnivoice] failed to save voice profile "${key}": ${String(err)}`);
    }
  }

  /**
   * Swaps a design/auto request onto a stored clone reference, so every
   * recording for the same customization tags keeps the same voice. Clone
   * requests already carry their own reference and are returned untouched.
   */
  private withVoiceProfile(request: OmniVoiceRequest): OmniVoiceRequest {
    if (!request.useVoiceReference || request.mode === "clone") return request;
    const key = voiceProfileKey(request.instruct);
    const reference = this.loadVoiceProfile(key);
    const pcmBase64 = reference ? this.readVoiceProfilePcm(key) : null;
    if (!reference || !pcmBase64) return request;
    return {
      ...request,
      mode: "clone",
      instruct: undefined,
      refPcm: { base64: pcmBase64, sampleRate: reference.sampleRate },
      refText: reference.text,
    };
  }

  async generate(request: OmniVoiceRequest): Promise<OmniVoiceResponse> {
    // The profile key comes from the caller's tags, before the request is
    // swapped onto a stored clone reference (which clears `instruct`).
    const profileKey = voiceProfileKey(request.instruct);
    const effective = this.withVoiceProfile(request);
    const cacheKey = effective.text.trim();
    const fingerprint = omniVoiceFingerprint(effective);
    const cached = this.ttsCache.get(cacheKey, fingerprint);
    if (cached) return { ok: true, wavBase64: cached.wavBase64, ms: 0, cached: true };
    if (this.current) return { ok: false, error: "A generation is already running." };
    const commands = await this.resolveCommands();
    if (commands.length === 0) return { ok: false, error: BUILD_HINT(this.binDir) };
    this.cancelled = false;

    const dir = mkdtempSync(join(tmpdir(), "minion-hci-omnivoice-"));
    try {
      await this.ensureWeights();
      const [base, codec] = this.weights.map((w) => w.runtime.localFilePath) as [string, string];
      const output = join(dir, "out.wav");

      let refWav: string | undefined;
      let refTextPath: string | undefined;
      if (effective.mode === "clone" && effective.refPcm && effective.refText?.trim()) {
        refWav = join(dir, "ref.wav");
        refTextPath = join(dir, "ref.txt");
        await Bun.write(refWav, encodeWav16(base64ToFloat32(effective.refPcm.base64), effective.refPcm.sampleRate));
        await Bun.write(refTextPath, effective.refText.trim());
      }
      const args = buildTtsArgs(effective, { model: base, codec, output, refWav, refTextPath });

      const started = performance.now();
      // Candidates in preference order (GPU build first). One that can't start
      // (e.g. no Vulkan loader) or fails (GPU error) falls through to the next,
      // unless the user cancelled — that kill must not trigger a retry.
      let stdout = "";
      let stderr = "";
      let failure = BUILD_HINT(this.binDir);
      let succeeded = false;
      for (const [i, command] of commands.entries()) {
        let proc: ReturnType<typeof Bun.spawn>;
        try {
          proc = Bun.spawn([...command, ...args], { stdin: new Blob([effective.text.trim()]), stdout: "pipe", stderr: "pipe" });
        } catch {
          continue;
        }
        this.current = proc;
        let code: number;
        [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited,
        ]);
        if (code === 0) {
          succeeded = true;
          break;
        }
        const tail = (stderr || stdout).trim().split("\n").slice(-12).join("\n");
        failure = `omnivoice-tts exited with code ${code}.\n${tail}`;
        if (this.cancelled) break;
        const next = commands[i + 1];
        if (next) console.warn(`[omnivoice] ${command[0]} failed (code ${code}); trying ${next[0]}\n${tail}`);
      }
      if (!succeeded) return { ok: false, error: failure };
      // Which backend ran (e.g. "[Load] TTS backend: CPU (CPU threads: 8)"):
      // the first thing to check when synthesis is slow.
      for (const line of `${stderr}\n${stdout}`.split(/\r?\n/)) {
        if (/backend:/i.test(line)) console.log(`[omnivoice] ${line.trim()}`);
      }
      console.log(`[omnivoice] synthesized in ${Math.round(performance.now() - started)} ms`);
      const wav = Bun.file(output);
      if (!(await wav.exists())) return { ok: false, error: "omnivoice-tts finished but wrote no audio file." };
      const wavBytes = new Uint8Array(await wav.arrayBuffer());
      this.ttsCache.set(cacheKey, fingerprint, wavBytes);
      // Grow the profile from what was just generated (a fresh design, or a
      // clone of the existing reference), so the next recording in this profile
      // benefits from the best-length reference so far. An explicit clone
      // request carries its own reference and never seeds a profile.
      if (request.useVoiceReference && request.mode !== "clone") {
        this.considerVoiceProfile(profileKey, request.instruct?.trim() ?? "", wavBytes, effective.text.trim());
      }
      return { ok: true, wavBase64: Buffer.from(wavBytes).toString("base64"), ms: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.current = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    const proc = this.current;
    proc?.kill();
    for (const { runtime } of this.weights) runtime.cancel();
    if (proc) {
      // Wait for the killed process to be reaped so an immediate re-generate
      // (e.g. "Start over" replaying the welcome) doesn't race the "already
      // running" guard in generate().
      try {
        await proc.exited;
      } catch {
        // Killed processes may reject; nothing to do.
      }
    }
  }

  dispose(): void {
    void this.cancel();
  }
}
