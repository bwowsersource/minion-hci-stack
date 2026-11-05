// Demo suite: one run through every model in the stack.
//
//   bun run demo [--skip-bonsai] [--gpu-layers N] [--steps N] <modelsPath> "<text>" [outDir]
//
// All models are loaded first (OmniVoice, Bonsai, Whistle, Needle), then run in this order:
//
//   1. Bonsai (the minion GGUF, node-llama-cpp)  text      -> output.txt   (--skip-bonsai: the text is used as is)
//   2. OmniVoice                                 output.txt -> output.wav
//   3. Whistle                                   output.wav -> output.json
//   4. Needle                                    yes/no function call: does output.json match output.txt? -> crosscheck.json
//   5. timestamps.txt                            elapsed time per step, model load and inference timed apart
//
// Weights are read from / downloaded into <modelsPath>/{minion,omnivoice,needle3,whistle}.
// "load" is getting the model ready (any first-run download, loading it into memory); "inference" is the work
// itself. OmniVoice runs as a process per request, so its "load" is only the weight check/download: the binary
// loads the weights again inside every synthesis, which is counted as inference.

import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { CactusManager, MinionInferenceRuntime, OmniVoiceManager, configureStack, loadRuntimeModule } from "../src";
import { cactusCacheDir } from "../src/config";
import { float32ToBase64 } from "../src/protocol/cactus";
import { decodeWav } from "../src/protocol/omnivoice";

// Weight files the demo uses, under <modelsPath>. Bonsai (node-llama-cpp, the benchmark model) is never
// downloaded; OmniVoice's files are downloaded on first use if missing (names match OMNIVOICE_WEIGHTS).
const BONSAI_MODEL = "Bonsai-27B-Q1_0.gguf"; // <modelsPath>/minion/
const OMNIVOICE_BASE_MODEL = "omnivoice-base-Q8_0.gguf"; // <modelsPath>/omnivoice/
const OMNIVOICE_CODEC_MODEL = "omnivoice-tokenizer-Q8_0.gguf"; // <modelsPath>/omnivoice/

// --gpu-layers N (or $MINION_HCI_GPU_LAYERS): layers of Bonsai to offload to the GPU; 0 = CPU only.
const args = process.argv.slice(2);
// --skip-bonsai: leave the minion out; the input text is spoken as is (useful when only the audio models are of interest).
const skipBonsai = args.includes("--skip-bonsai");
if (skipBonsai) args.splice(args.indexOf("--skip-bonsai"), 1);
let gpuLayers: number | undefined = process.env.MINION_HCI_GPU_LAYERS ? Number(process.env.MINION_HCI_GPU_LAYERS) : undefined;
const flag = args.indexOf("--gpu-layers");
if (flag >= 0) {
  gpuLayers = Number(args[flag + 1]);
  args.splice(flag, 2);
}
if (gpuLayers !== undefined && !Number.isInteger(gpuLayers)) {
  console.error("--gpu-layers needs an integer");
  process.exit(2);
}
// --steps N: OmniVoice MaskGIT decode steps. Default 16; the binary's own default is 32, which takes about twice as long on CPU.
let steps = 16;
const stepsFlag = args.indexOf("--steps");
if (stepsFlag >= 0) {
  steps = Number(args[stepsFlag + 1]);
  args.splice(stepsFlag, 2);
}
if (!Number.isInteger(steps) || steps < 1) {
  console.error("--steps needs a positive integer");
  process.exit(2);
}
const [modelsArg, text, outArg] = args;
if (!modelsArg || !text?.trim()) {
  console.error('usage: bun run demo [--skip-bonsai] [--gpu-layers N] [--steps N] <modelsPath> "<text>" [outDir]');
  process.exit(2);
}
const modelsDir = resolve(modelsArg);
const outDir = resolve(outArg ?? "demo-output");
mkdirSync(outDir, { recursive: true });
configureStack({ modelsDir });

/** Whistle rejects clips longer than this. */
const MAX_CLIP_SECONDS = 30;

const timings: { step: string; ms: number }[] = [];
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  console.log(`\n== ${name}`);
  const started = performance.now();
  try {
    return await run();
  } finally {
    const ms = performance.now() - started;
    timings.push({ step: name, ms });
    console.log(`-- ${name}: ${(ms / 1000).toFixed(2)}s`);
  }
}

function bonsaiPath(): string {
  const path = join(modelsDir, "minion", BONSAI_MODEL);
  if (!existsSync(path)) throw new Error(`${path} not found.`);
  return path;
}

const total = performance.now();
const ttsLog = () => {};

// Load everything up front
const modelPath = skipBonsai ? null : bonsaiPath();
if (modelPath) console.log(`model: ${modelPath}${gpuLayers === undefined ? "" : ` (gpu layers: ${gpuLayers})`}`);
else console.log("bonsai skipped: the input text is spoken as is");

const tts = new OmniVoiceManager(ttsLog);
await step("omnivoice load", () => tts.downloadModels());

const bonsai = modelPath ? new MinionInferenceRuntime(() => modelPath, { gpuLayers }) : null;
if (bonsai) {
  await step("bonsai load", () => bonsai.load());
  // A failed GPU attempt is timed apart from the CPU retry; with no failure the single row stays as is.
  if (bonsai.failedAttempts.length) {
    const row = timings.findIndex((t) => t.step === "bonsai load");
    const failed = bonsai.failedAttempts.map((a) => ({ step: `bonsai load (${a.device}, failed)`, ms: a.ms }));
    const retryMs = timings[row]!.ms - failed.reduce((sum, a) => sum + a.ms, 0);
    timings.splice(row, 1, ...failed, { step: "bonsai load (cpu)", ms: retryMs });
  }
}

// No microphone in the demo: the capture backend is never used for file transcription.
const cactus = new CactusManager(ttsLog, ttsLog, ttsLog, {
  findRecorder: () => ({ ok: false, error: "no microphone in the demo" }),
  startRecording: () => {
    throw new Error("no microphone in the demo");
  },
});
const loaded = await step("whistle load", () => cactus.call({ op: "whistle.load" }));
if (!loaded.ok) throw new Error(loaded.error);

const { createNeedle, downloadModel, tool } = await loadRuntimeModule<typeof import("cactus-needle")>("cactus-needle");
const needle = await step("needle load", async () =>
  createNeedle({ modelPath: await downloadModel({ model: "needle3", cacheDir: cactusCacheDir("needle3") }) }),
);

// 1. Bonsai
let outputText = text;
if (bonsai) {
  // Kept short: it gets spoken, then transcribed by Whistle (30 s clip limit).
  const generated = await step("bonsai inference", () => bonsai.generateText(text, { jsonMode: false, maxTokens: 96 }));
  outputText = generated.generatedText;
  if (!outputText) throw new Error("Bonsai returned an empty response.");
}
await Bun.write(join(outDir, "output.txt"), `${outputText}\n`);
console.log(outputText);

// 2. TTS
const wavBytes = await step("omnivoice inference", async () => {
  const result = await tts.generate({ mode: "auto", text: outputText, steps });
  if (!result.ok) throw new Error(result.error);
  return new Uint8Array(Buffer.from(result.wavBase64, "base64"));
});
await Bun.write(join(outDir, "output.wav"), wavBytes);

// 3. Whistle
const clip = decodeWav(wavBytes);
if (!clip) throw new Error("output.wav is not a WAV file Whistle input can be decoded from.");
const clipLimit = MAX_CLIP_SECONDS * clip.sampleRate;
const truncated = clip.samples.length > clipLimit;
const clipSamples = truncated ? clip.samples.slice(0, clipLimit) : clip.samples;
const transcript = await step("whistle inference", async () => {
  const response = await cactus.call({
    op: "whistle.transcribe",
    pcm: { base64: float32ToBase64(clipSamples), sampleRate: clip.sampleRate },
    settings: { language: "en", wordTimestamps: true },
  });
  if (!response.ok) throw new Error(response.error);
  return { ...(response.value as { text: string }), truncatedTo30s: truncated };
});
await Bun.write(join(outDir, "output.json"), `${JSON.stringify(transcript, null, 2)}\n`);
const transcribed = transcript.text.trim();
console.log(transcribed);

// 4. Needle: a yes/no function call. CactusManager's needle ops only expose its demo
// tools, so this step drives cactus-needle directly with its own `verdict` tool.
const verdict = await step("needle inference", async () => {
  const result = await needle.generate({
    prompt:
      `Original text: "${outputText}"\n` +
      `Speech-to-text transcript: "${transcribed}"\n` +
      `Do the original text and the transcript say the same thing? Call answer with yes or no.`,
    tools: {
      answer: tool({
        description: "Report whether the transcript matches the original text.",
        inputSchema: {
          type: "object",
          properties: { match: { type: "string", enum: ["yes", "no"] } },
          required: ["match"],
        },
      }),
    },
  });
  const call = result.toolCalls[0];
  return {
    match: call?.input.match ?? null,
    confidence: result.confidence,
    toolCalls: result.toolCalls,
  };
});
await Bun.write(join(outDir, "crosscheck.json"), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(`match: ${verdict.match ?? "no verdict"}`);

// Unload everything
tts.dispose();
await cactus.call({ op: "whistle.unload" });
await needle.close();
await bonsai?.dispose();

// 5. Timings
timings.push({ step: "total", ms: performance.now() - total });
const width = Math.max(...timings.map((t) => t.step.length));
const table = `${timings.map((t) => `${t.step.padEnd(width)}  ${(t.ms / 1000).toFixed(2)}s`).join("\n")}\n`;
await Bun.write(join(outDir, "timestamps.txt"), table);
console.log(`\n${table}`);
console.log(`\nwrote ${outDir}: output.txt output.wav output.json crosscheck.json timestamps.txt`);
