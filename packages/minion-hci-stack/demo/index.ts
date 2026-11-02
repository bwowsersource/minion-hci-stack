// Demo suite: one run through every model in the stack.
//
//   bun run demo <modelsPath> "<text>" [outDir]
//
//   1. Bonsai (the minion GGUF, node-llama-cpp)  text      -> output.txt
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

const [modelsArg, text, outArg] = process.argv.slice(2);
if (!modelsArg || !text?.trim()) {
  console.error('usage: bun run demo <modelsPath> "<text>" [outDir]');
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
    timings.push({ step: name, ms: performance.now() - started });
  }
}

function bonsaiPath(): string {
  const path = join(modelsDir, "minion", BONSAI_MODEL);
  if (!existsSync(path)) throw new Error(`${path} not found.`);
  return path;
}

const total = performance.now();
const ttsLog = () => {};

// 1. Bonsai
const modelPath = bonsaiPath();
console.log(`model: ${modelPath}`);
const bonsai = new MinionInferenceRuntime(() => modelPath);
await step("bonsai load", () => bonsai.load());
const generated = await step("bonsai inference", () =>
  // Kept short: it gets spoken, then transcribed by Whistle (30 s clip limit).
  bonsai.generateText(text, { jsonMode: false, maxTokens: 96 }),
);
await bonsai.dispose();
const outputText = generated.generatedText;
if (!outputText) throw new Error("Bonsai returned an empty response.");
await Bun.write(join(outDir, "output.txt"), `${outputText}\n`);
console.log(outputText);

// 2. TTS
const tts = new OmniVoiceManager(ttsLog);
await step("omnivoice load", () => tts.downloadModels());
const wavBytes = await step("omnivoice inference", async () => {
  const result = await tts.generate({ mode: "auto", text: outputText });
  if (!result.ok) throw new Error(result.error);
  return new Uint8Array(Buffer.from(result.wavBase64, "base64"));
});
tts.dispose();
await Bun.write(join(outDir, "output.wav"), wavBytes);

// 3. Whistle
const clip = decodeWav(wavBytes);
if (!clip) throw new Error("output.wav is not a WAV file Whistle input can be decoded from.");
const clipLimit = MAX_CLIP_SECONDS * clip.sampleRate;
const truncated = clip.samples.length > clipLimit;
const clipSamples = truncated ? clip.samples.slice(0, clipLimit) : clip.samples;
// No microphone in the demo: the capture backend is never used for file transcription.
const cactus = new CactusManager(ttsLog, ttsLog, ttsLog, {
  findRecorder: () => ({ ok: false, error: "no microphone in the demo" }),
  startRecording: () => {
    throw new Error("no microphone in the demo");
  },
});
const loaded = await step("whistle load", () => cactus.call({ op: "whistle.load" }));
if (!loaded.ok) throw new Error(loaded.error);
const transcript = await step("whistle inference", async () => {
  const response = await cactus.call({
    op: "whistle.transcribe",
    pcm: { base64: float32ToBase64(clipSamples), sampleRate: clip.sampleRate },
    settings: { language: "en", wordTimestamps: true },
  });
  if (!response.ok) throw new Error(response.error);
  return { ...(response.value as { text: string }), truncatedTo30s: truncated };
});
await cactus.call({ op: "whistle.unload" });
await Bun.write(join(outDir, "output.json"), `${JSON.stringify(transcript, null, 2)}\n`);
const transcribed = transcript.text.trim();
console.log(transcribed);

// 4. Needle: a yes/no function call. CactusManager's needle ops only expose its demo
// tools, so this step drives cactus-needle directly with its own `verdict` tool.
const { createNeedle, downloadModel, tool } = await loadRuntimeModule<typeof import("cactus-needle")>("cactus-needle");
const needle = await step("needle load", async () =>
  createNeedle({ modelPath: await downloadModel({ model: "needle3", cacheDir: cactusCacheDir("needle3") }) }),
);
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
await needle.close();
await Bun.write(join(outDir, "crosscheck.json"), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(`match: ${verdict.match ?? "no verdict"}`);

// 5. Timings
timings.push({ step: "total", ms: performance.now() - total });
const width = Math.max(...timings.map((t) => t.step.length));
await Bun.write(
  join(outDir, "timestamps.txt"),
  `${timings.map((t) => `${t.step.padEnd(width)}  ${(t.ms / 1000).toFixed(2)}s`).join("\n")}\n`,
);
console.log(`\nwrote ${outDir}: output.txt output.wav output.json crosscheck.json timestamps.txt`);
