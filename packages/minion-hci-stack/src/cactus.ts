import { setTimeout as sleep } from "node:timers/promises";
import type { Needle, Whistle } from "cactus-needle";
import { loadRuntimeModule } from "./runtime.ts";
import { cactusCacheDir } from "./config.ts";
import type {
  CactusCallRequest,
  CactusCallResponse,
  CactusMicMessage,
  CactusProgressMessage,
  CactusSpeechSettings,
  CactusStreamMessage,
} from "./protocol/cactus.ts";
import { base64ToFloat32, joinTranscript } from "./protocol/cactus.ts";
import { AsyncQueue } from "./protocol/asyncQueue.ts";
import { gateBackground, StreamingVoiceGate } from "./protocol/audioGate.ts";
import { SpeechEndpointer } from "./protocol/endpointer.ts";
import { MIC_SAMPLE_RATE } from "./protocol/mic.ts";
import type { MicCapture, Recorder, RecordingHandle } from "./protocol/mic.ts";

// Backs the "Cactus" example tab. Needle (tool calling / extraction /
// embeddings) and Whistle (speech-to-text) each get one lazily-created
// session that lives until unloaded. Model weights download from Hugging Face
// into <modelsDir>/<needle3|whistle> (see config.ts) on first load.

// cactus-needle is resolved from node_modules at runtime (never bundled), so it loads on first use: a missing install must fail
// this feature, not app startup. `needleLib` is set once loaded so synchronous
// helpers (describeError) can reach NeedleError.
let needleLib: typeof import("cactus-needle") | null = null;
async function loadNeedleLib() {
  needleLib ??= await loadRuntimeModule<typeof import("cactus-needle")>("cactus-needle");
  return needleLib;
}

const lights = new Map<string, boolean>();

function makeTools(tool: typeof import("cactus-needle").tool) {
  return {
    set_lights: tool({
      description: "Turn the lights in a room on or off.",
      inputSchema: {
        type: "object",
        properties: { room: { type: "string" }, on: { type: "boolean" } },
        required: ["room", "on"],
      },
      execute: ({ room, on }: { room: string; on: boolean }) => {
        lights.set(room, on);
        return { room, on };
      },
    }),
    set_thermostat: tool({
      description: "Set the target temperature in degrees Celsius.",
      inputSchema: {
        type: "object",
        properties: { celsius: { type: "number" } },
        required: ["celsius"],
      },
      execute: ({ celsius }: { celsius: number }) => ({ celsius }),
    }),
    get_weather: tool({
      description: "Get the current weather for a city.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } },
        required: ["city"],
      },
      execute: ({ city }: { city: string }) => ({ city, condition: "sunny", temperature: 21 }),
    }),
  };
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
    attendees: { type: "number" },
    confirmed: { type: "boolean" },
  },
  required: ["name", "email"],
} as const;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function describeError(err: unknown): string {
  if (needleLib && err instanceof needleLib.NeedleError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Whistle rejects a single transcribe() call longer than this. */
const MAX_CLIP_SECONDS = 30;
/** Live chunks are ~1 s of 16 kHz audio, as Whistle's stream() expects. */
const STREAM_CHUNK_SAMPLES = MIC_SAMPLE_RATE;
const LEVEL_INTERVAL_MS = 100;
/**
 * How long the capture process stays open after a turn. Long enough that a
 * retry reuses the warm device instead of racing a fresh acquisition, short
 * enough that an idle app isn't holding the microphone.
 */
const RECORDER_IDLE_GRACE_MS = 15_000;
/** How long a freshly spawned recorder has to deliver its first frame. */
const RECORDER_FIRST_FRAME_MS = 1200;
/** Gaps before re-spawning a recorder that never produced a frame. */
const RECORDER_SPAWN_DELAYS_MS = [0, 300, 600, 1200, 2000];

type Clip = { samples: Float32Array; sampleRate: number };
type Recording = { parts: Float32Array[]; total: number; lowerBackground: boolean };
/** Seconds before the clip limit at which warnings are sent (one per whole second). */
const WARNING_SECONDS = 5;
type LiveStream = {
  queue: AsyncQueue<Float32Array>;
  done: Promise<void>;
  /** Pushes any buffered tail to the queue. */
  flush: () => void;
  /** The transcript accumulated from the stream's parts, updated as it runs. */
  finalText: string;
  /** Whether the voice-activity gate ever let audio reach the model. */
  speechDetected: boolean;
};

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

export class CactusManager {
  private needle: Promise<Needle> | null = null;
  private whistle: Promise<Whistle> | null = null;
  private live: LiveStream | null = null;
  private recording: Recording | null = null;
  /**
   * The one capture process, kept warm across turns so a retry never races the
   * OS re-acquiring the device (see RECORDER_IDLE_GRACE_MS).
   */
  private recorder: { handle: RecordingHandle; name: string } | null = null;
  /** In-flight spawn, shared by concurrent `ensureRecorder` callers. */
  private recorderStarting: Promise<RecordingHandle> | null = null;
  /** Last stderr/exit reason from a failed recorder probe, for the error message. */
  private lastRecorderExit: string | null = null;
  /** Where the warm recorder's samples go right now; null discards them. */
  private sink: ((samples: Float32Array) => void) | null = null;
  /** Stops the warm recorder once the grace period after a turn lapses. */
  private recorderIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The clip `whistle.embed` runs on: the last recording or transcribed file. */
  private lastClip: Clip | null = null;

  private readonly sendProgress: (message: CactusProgressMessage) => void;
  private readonly sendStream: (message: CactusStreamMessage) => void;
  private readonly sendMic: (message: CactusMicMessage) => void;
  /** The microphone backend; it stays in the host app because it needs the host's ffmpeg setup. */
  private readonly mic: MicCapture;

  constructor(
    sendProgress: (message: CactusProgressMessage) => void,
    sendStream: (message: CactusStreamMessage) => void,
    sendMic: (message: CactusMicMessage) => void,
    mic: MicCapture,
  ) {
    this.sendProgress = sendProgress;
    this.sendStream = sendStream;
    this.sendMic = sendMic;
    this.mic = mic;
  }

  /**
   * Ensures the Weights for one Cactus model are cached on disk. Idempotent:
   * cactus-needle reuses an already-downloaded model. Used by onboarding so the
   * first real call doesn't have to wait on a multi-hundred-MB download.
   */
  async downloadModels(which: "needle" | "whistle"): Promise<void> {
    const { downloadModel } = await loadNeedleLib();
    await downloadModel({
      model: which === "needle" ? "needle3" : "whistle",
      cacheDir: cactusCacheDir(which === "needle" ? "needle3" : "whistle"),
      onProgress: this.progressReporter(which),
    });
  }

  async call(request: CactusCallRequest): Promise<CactusCallResponse> {
    try {
      return await this.dispatch(request);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  /** Download progress, throttled to whole-percent changes so the RPC isn't flooded. */
  private progressReporter(model: "needle" | "whistle") {
    let last = -1;
    return ({ receivedBytes, totalBytes }: { receivedBytes: number; totalBytes?: number }) => {
      const percentage = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : null;
      if (percentage === last) return;
      last = percentage ?? -1;
      this.sendProgress({ model, percentage });
    };
  }

  private getNeedle(): Promise<Needle> {
    if (!this.needle) {
      const pending = (async () => {
        const { downloadModel, createNeedle, tool } = await loadNeedleLib();
        const modelPath = await downloadModel({
          model: "needle3",
          cacheDir: cactusCacheDir("needle3"),
          onProgress: this.progressReporter("needle"),
        });
        return createNeedle({ tools: makeTools(tool), modelPath });
      })();
      this.needle = pending;
      pending.catch(() => {
        if (this.needle === pending) this.needle = null;
      });
    }
    return this.needle;
  }

  private getWhistle(): Promise<Whistle> {
    if (!this.whistle) {
      const pending = (async () => {
        const { downloadModel, createWhistle } = await loadNeedleLib();
        const modelPath = await downloadModel({
          model: "whistle",
          cacheDir: cactusCacheDir("whistle"),
          onProgress: this.progressReporter("whistle"),
        });
        return createWhistle({ modelPath });
      })();
      this.whistle = pending;
      pending.catch(() => {
        if (this.whistle === pending) this.whistle = null;
      });
    }
    return this.whistle;
  }

  private speechOptions(settings: CactusSpeechSettings) {
    return {
      language: settings.language,
      keywords: settings.keywords?.length ? settings.keywords : undefined,
    };
  }

  private async dispatch(request: CactusCallRequest): Promise<CactusCallResponse> {
    switch (request.op) {
      case "needle.load":
        await this.getNeedle();
        return { ok: true, value: "loaded" };
      case "needle.unload": {
        const pending = this.needle;
        this.needle = null;
        if (pending) await pending.then((n) => n.close()).catch(() => {});
        return { ok: true, value: "unloaded" };
      }
      case "needle.reset": {
        const needle = await this.getNeedle();
        await needle.reset();
        return { ok: true, value: "reset() ok — history cleared, model still loaded." };
      }
      case "needle.complete": {
        const needle = await this.getNeedle();
        return { ok: true, value: await needle.complete(request.prompt) };
      }
      case "needle.generate": {
        const needle = await this.getNeedle();
        const result = await needle.generate(
          request.lightsOnly
            ? { prompt: request.prompt, tools: { set_lights: makeTools((await loadNeedleLib()).tool).set_lights } }
            : { prompt: request.prompt },
        );
        return {
          ok: true,
          value: {
            ...(request.lightsOnly ? { toolsOverride: ["set_lights"] } : {}),
            toolCalls: result.toolCalls,
            suppressedToolCalls: result.suppressedToolCalls,
            confidence: result.confidence,
            reasoning: result.reasoning,
          },
        };
      }
      case "needle.run": {
        const needle = await this.getNeedle();
        const result = await needle.run(request.prompt, { maxSteps: request.maxSteps, strict: request.strict });
        return { ok: true, value: { results: result.results, lights: Object.fromEntries(lights), completion: result } };
      }
      case "needle.extract": {
        const needle = await this.getNeedle();
        return { ok: true, value: await needle.extract(request.text, EXTRACT_SCHEMA as never, { strict: request.strict }) };
      }
      case "needle.embed": {
        const needle = await this.getNeedle();
        const [a, b, c] = [await needle.embed(request.texts[0]), await needle.embed(request.texts[1]), await needle.embed(request.texts[2])];
        return {
          ok: true,
          value: {
            dimensions: a.length,
            "cosine(A,B)": Number(cosine(a, b).toFixed(4)),
            "cosine(A,C)": Number(cosine(a, c).toFixed(4)),
            "first 5 of A": Array.from(a.slice(0, 5)),
          },
        };
      }
      case "needle.abort": {
        const needle = await this.getNeedle();
        const controller = new AbortController();
        const pending = needle.complete(request.prompt, { abortSignal: controller.signal });
        controller.abort(new Error("aborted by example"));
        try {
          await pending;
          return { ok: true, value: "Call finished before the abort took effect." };
        } catch (err) {
          // Aborting an active call terminates the session; the next call recreates it.
          this.needle = null;
          return {
            ok: true,
            sessionClosed: true,
            value: `Rejected as expected: ${describeError(err)}\nSession was terminated and will be recreated on next use.`,
          };
        }
      }
      case "whistle.load":
        await this.getWhistle();
        return { ok: true, value: "loaded" };
      case "whistle.unload": {
        this.clearRecorderIdle();
        await this.stopRecorder();
        await this.stopStream();
        const pending = this.whistle;
        this.whistle = null;
        if (pending) await pending.then((w) => w.close()).catch(() => {});
        return { ok: true, value: "unloaded" };
      }
      case "whistle.transcribe": {
        const samples = base64ToFloat32(request.pcm.base64);
        this.lastClip = { samples, sampleRate: request.pcm.sampleRate };
        return { ok: true, value: await this.transcribeClip(this.lastClip, request.settings) };
      }
      case "whistle.embed": {
        const clip = this.lastClip;
        if (!clip) throw new Error("Record or pick a clip first.");
        const whistle = await this.getWhistle();
        const features = await whistle.embed({ samples: clip.samples, sampleRate: clip.sampleRate });
        const seconds = clip.samples.length / clip.sampleRate;
        const frames = Math.max(1, Math.round(seconds / 0.08));
        return {
          ok: true,
          value: {
            clipSeconds: Number(seconds.toFixed(2)),
            totalValues: features.length,
            approxFrames: frames,
            approxFeaturesPerFrame: Math.round(features.length / frames),
            "first 5": Array.from(features.slice(0, 5)),
          },
        };
      }
      case "mic.check": {
        console.log("[mic] check");
        const found = this.mic.findRecorder();
        if (!found.ok) throw new Error(found.error);
        return { ok: true, value: { recorder: found.recorder.name, command: found.recorder.argv.join(" ") } };
      }
      case "whistle.recordStart": {
        if (this.live) throw new Error("The microphone is already in use.");
        // Reuse the already-warm recorder; this only spawns on the very first
        // turn (or after the idle grace period released it).
        this.clearRecorderIdle();
        await this.ensureRecorder();
        const recording: Recording = { parts: [], total: 0, lowerBackground: request.assist?.lowerBackground === true };
        const endpointer = request.assist?.autoStop ? new SpeechEndpointer(request.assist.autoStop) : null;
        const warned = new Set<number>();
        let lastLevel = 0;
        let limitSent = false;
        this.recording = recording;
        this.sink = (samples) => {
          recording.parts.push(samples);
          recording.total += samples.length;
          const seconds = recording.total / MIC_SAMPLE_RATE;
          const now = Date.now();
          const level = rms(samples);
          const event = endpointer?.push(level, samples.length / MIC_SAMPLE_RATE);
          if (now - lastLevel >= LEVEL_INTERVAL_MS) {
            lastLevel = now;
            this.sendMic({ kind: "level", target: "record", level, seconds, endpoint: endpointer?.snapshot() });
          }
          if (event === "end") this.sendMic({ kind: "endpoint" });
          else if (event === "no-speech") this.sendMic({ kind: "noSpeech" });
          if (request.assist?.warnBeforeLimit) {
            const left = Math.ceil(MAX_CLIP_SECONDS - seconds);
            if (left >= 1 && left <= WARNING_SECONDS && !warned.has(left)) {
              warned.add(left);
              this.sendMic({ kind: "warning", secondsLeft: left });
            }
          }
          if (seconds >= MAX_CLIP_SECONDS && !limitSent) {
            limitSent = true;
            this.sendMic({ kind: "limit" });
          }
        };
        const name = this.recorder?.name ?? "recorder";
        console.log(`[mic] recordStart -> ${name}`);
        return { ok: true, value: { recorder: name } };
      }
      case "whistle.recordStop": {
        const recording = this.recording;
        if (!recording) throw new Error("Not recording.");
        console.log("[mic] recordStop");
        this.recording = null;
        this.sink = null;
        this.scheduleRecorderIdle();
        const all = concat(recording.parts);
        if (all.length === 0) {
          throw new Error("No audio was captured. Check the microphone and that this app is allowed to use it.");
        }
        const clipped = all.subarray(0, MAX_CLIP_SECONDS * MIC_SAMPLE_RATE);
        const samples = recording.lowerBackground ? gateBackground(clipped, MIC_SAMPLE_RATE) : clipped;
        this.lastClip = { samples, sampleRate: MIC_SAMPLE_RATE };
        return {
          ok: true,
          value: { clipSeconds: Number((samples.length / MIC_SAMPLE_RATE).toFixed(2)), transcription: await this.transcribeClip(this.lastClip, request.settings) },
        };
      }
      case "whistle.recordCancel": {
        console.log(`[mic] recordCancel active=${!!this.recording} live=${!!this.live}`);
        this.recording = null;
        this.sink = null;
        const live = this.live;
        if (live) {
          this.live = null;
          live.flush();
          live.queue.close();
        }
        this.scheduleRecorderIdle();
        return { ok: true, value: "cancelled" };
      }
      case "whistle.streamStart": {
        if (this.live || this.recording) throw new Error("The microphone is already in use.");
        this.clearRecorderIdle();
        await this.ensureRecorder();
        const whistle = await this.getWhistle();
        const queue = new AsyncQueue<Float32Array>();
        const options = this.speechOptions(request.settings);
        const live: LiveStream = { queue, done: Promise.resolve(), flush: () => {}, finalText: "", speechDetected: false };
        this.live = live;
        live.done = (async () => {
          const committed: string[] = [];
          try {
            for await (const part of whistle.stream(queue, options)) {
              if (part.text) committed.push(part.text);
              live.finalText = joinTranscript(committed, part.pending);
              this.sendStream({
                kind: "part",
                text: part.text,
                pending: part.pending,
                language: part.language,
                received: part.received,
                passMs: part.passMs,
              });
            }
            this.sendStream({ kind: "end" });
          } catch (err) {
            this.sendStream({ kind: "error", error: describeError(err) });
          } finally {
            if (this.live === live) this.live = null;
          }
        })();

        // Re-chunk the recorder's arbitrary read sizes into ~1 s blocks.
        let buffered: Float32Array[] = [];
        let bufferedCount = 0;
        let streamed = 0;
        let lastLevel = 0;
        let limitSent = false;
        const warned = new Set<number>();
        // Same assist as recordStart: auto-stop on silence, warn before the clip
        // limit, and feed the endpoint snapshot to the mic meter.
        const endpointer = request.assist?.autoStop ? new SpeechEndpointer(request.assist.autoStop) : null;
        // Voice-activity gate: keystrokes and background noise must reach the
        // endpointer (so the meter and auto-stop work) but not Whistle, which
        // hallucinates words like "thank you" from them. The gate releases a
        // short pre-roll when speech starts so the first word isn't clipped.
        const gate = new StreamingVoiceGate(MIC_SAMPLE_RATE, { speaking: () => endpointer?.speaking ?? true });
        const emit = (final: boolean) => {
          let all = concat(buffered);
          while (all.length >= STREAM_CHUNK_SAMPLES) {
            queue.push(all.slice(0, STREAM_CHUNK_SAMPLES));
            all = all.slice(STREAM_CHUNK_SAMPLES);
          }
          if (final && all.length) queue.push(all);
          buffered = all.length && !final ? [all] : [];
          bufferedCount = final ? 0 : all.length;
        };
        const feed = (block: Float32Array) => {
          buffered.push(block);
          bufferedCount += block.length;
          if (bufferedCount >= STREAM_CHUNK_SAMPLES) emit(false);
        };
        this.sink = (samples) => {
          streamed += samples.length;
          const seconds = streamed / MIC_SAMPLE_RATE;
          const level = rms(samples);
          const event = endpointer?.push(level, samples.length / MIC_SAMPLE_RATE);
          const now = Date.now();
          if (now - lastLevel >= LEVEL_INTERVAL_MS) {
            lastLevel = now;
            this.sendMic({ kind: "level", target: "stream", level, seconds, endpoint: endpointer?.snapshot() });
          }
          if (event === "end") this.sendMic({ kind: "endpoint" });
          else if (event === "no-speech") this.sendMic({ kind: "noSpeech" });
          if (request.assist?.warnBeforeLimit) {
            const left = Math.ceil(MAX_CLIP_SECONDS - seconds);
            if (left >= 1 && left <= WARNING_SECONDS && !warned.has(left)) {
              warned.add(left);
              this.sendMic({ kind: "warning", secondsLeft: left });
            }
          }
          if (seconds >= MAX_CLIP_SECONDS && !limitSent) {
            limitSent = true;
            this.sendMic({ kind: "limit" });
          }
          for (const block of gate.push(samples)) feed(block);
          if (gate.openedOnce) live.speechDetected = true;
        };
        live.flush = () => emit(true);
        return { ok: true, value: { recorder: this.recorder?.name ?? "recorder" } };
      }
      case "whistle.streamStop": {
        const text = await this.stopStream();
        return { ok: true, value: { text } };
      }
    }
  }

  private async transcribeClip(clip: Clip, settings: CactusSpeechSettings) {
    const whistle = await this.getWhistle();
    return whistle.transcribe(
      { samples: clip.samples, sampleRate: clip.sampleRate },
      { ...this.speechOptions(settings), wordTimestamps: settings.wordTimestamps },
    );
  }

  /**
   * Stops routing to the stream, flushes the tail, and waits for Whistle's
   * final update. Returns the transcript accumulated from the stream's parts.
   */
  private async stopStream(): Promise<string> {
    const live = this.live;
    if (!live) return "";
    this.sink = null;
    live.flush();
    live.queue.close();
    await live.done;
    this.scheduleRecorderIdle();
    // No speech cleared the gate, so nothing was fed to the model; return
    // nothing rather than whatever Whistle hallucinated from the silence.
    return live.speechDetected ? live.finalText : "";
  }

  private clearRecorderIdle(): void {
    if (this.recorderIdleTimer !== null) {
      clearTimeout(this.recorderIdleTimer);
      this.recorderIdleTimer = null;
    }
  }

  /**
   * Keeps the warm recorder alive for a grace period after a turn, so a quick
   * retry reuses it. After that it's released (and the mic indicator goes off).
   */
  private scheduleRecorderIdle(): void {
    this.clearRecorderIdle();
    this.recorderIdleTimer = setTimeout(() => {
      this.recorderIdleTimer = null;
      if (this.sink) return; // a turn started in the meantime
      void this.stopRecorder();
    }, RECORDER_IDLE_GRACE_MS);
  }

  /**
   * The single capture process, opened on first use and then kept warm. If a
   * fresh spawn produces no frames (macOS sometimes hands the first recorder
   * after a device release an empty stream), it's retried with a growing gap.
   */
  private async ensureRecorder(): Promise<RecordingHandle> {
    if (this.recorder) return this.recorder.handle;
    if (this.recorderStarting) return this.recorderStarting;
    const found = this.mic.findRecorder();
    if (!found.ok) throw new Error(found.error);
    const starting = (async () => {
      try {
        this.lastRecorderExit = null;
        for (const delay of RECORDER_SPAWN_DELAYS_MS) {
          if (delay) await sleep(delay);
          const handle = await this.probeRecorder(found.recorder);
          if (handle) {
            this.recorder = { handle, name: found.recorder.name };
            console.log(`[mic] recorder ready (${found.recorder.name})`);
            return handle;
          }
        }
        const detail = this.lastRecorderExit ? ` Last recorder message: ${this.lastRecorderExit}` : "";
        throw new Error(
          `The microphone didn't produce any audio. Check the microphone and that this app is allowed to use it.${detail}`,
        );
      } finally {
        this.recorderStarting = null;
      }
    })();
    this.recorderStarting = starting;
    return starting;
  }

  /** Spawns one recorder and waits briefly for its first frame; null if it
   *  stayed silent or exited (and then it's torn down so the next can try). */
  private async probeRecorder(recorder: Recorder): Promise<RecordingHandle | null> {
    let frames = 0;
    let exited = false;
    const ref: { handle: RecordingHandle | null } = { handle: null };
    const handle = this.mic.startRecording(
      recorder,
      (samples) => {
        frames += samples.length;
        this.sink?.(samples);
      },
      (error) => {
        exited = true;
        this.lastRecorderExit = error ?? `${recorder.name} exited with no audio`;
        if (this.recorder?.handle === ref.handle) this.handleRecorderDeath(error);
      },
    );
    ref.handle = handle;
    const deadline = Date.now() + RECORDER_FIRST_FRAME_MS;
    while (frames === 0 && !exited && Date.now() < deadline) await sleep(50);
    if (frames > 0 && !exited) return handle;
    await handle.stop();
    return null;
  }

  /** The warm recorder died: drop it and reset whatever turn it was feeding. */
  private handleRecorderDeath(error: string | null): void {
    this.recorder = null;
    this.clearRecorderIdle();
    const message = error ?? "The recorder exited unexpectedly.";
    if (this.live) {
      this.sink = null;
      this.live.flush();
      this.live.queue.close();
      this.sendMic({ kind: "stopped", error: message });
      return;
    }
    if (this.recording) {
      this.recording = null;
      this.sink = null;
      this.sendMic({ kind: "stopped", error: message });
    }
  }

  /** Releases the capture process now (unload/quit). */
  private async stopRecorder(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) await recorder.handle.stop();
  }

  async dispose(): Promise<void> {
    this.clearRecorderIdle();
    await this.stopRecorder();
    await this.stopStream();
    const [needle, whistle] = [this.needle, this.whistle];
    this.needle = this.whistle = null;
    await needle?.then((n) => n.close()).catch(() => {});
    await whistle?.then((w) => w.close()).catch(() => {});
  }
}
