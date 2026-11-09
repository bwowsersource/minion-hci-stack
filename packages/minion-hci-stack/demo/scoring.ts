// Scoring demo: Bonsai's decideChoice on a few labelled documents.
//
//   npm run demo:scoring [--gpu-layers N] <modelsPath> [outDir]
//
// decideChoice does a single forward pass and reads the next-token probabilities of just the candidate
// choices, so each document gets a probability per choice rather than only a generated answer. For every
// case this prints those probabilities and whether the top choice matches the expected one, then the
// accuracy, mean confidence and per-case timing. Results are written to <outDir>/scoring.json.

import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MinionInferenceRuntime, configureStack } from "@bwowsersource/minion-hci-stack";

const BONSAI_MODEL = "Bonsai-27B-Q1_0.gguf"; // <modelsPath>/minion/

// --gpu-layers N (or $MINION_HCI_GPU_LAYERS): layers to offload to the GPU; 0 = CPU only.
const args = process.argv.slice(2);
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
const [modelsArg, outArg] = args;
if (!modelsArg) {
  console.error("usage: npm run demo:scoring [--gpu-layers N] <modelsPath> [outDir]");
  process.exit(2);
}
const modelsDir = resolve(modelsArg);
const outDir = resolve(outArg ?? "demo-output");
mkdirSync(outDir, { recursive: true });
configureStack({ modelsDir });

const modelPath = join(modelsDir, "minion", BONSAI_MODEL);
if (!existsSync(modelPath)) throw new Error(`${modelPath} not found.`);

type Case = { document: string; expected: string };

const INSTRUCTION = "Rate the sentiment of the review.";
const CRITERIA = {
  positive: "The reviewer is happy with the product.",
  neutral: "The reviewer is neither clearly happy nor unhappy.",
  negative: "The reviewer is unhappy with the product.",
};

const CASES: Case[] = [
  { document: "Battery lasts for days and the screen is gorgeous. Best purchase this year.", expected: "positive" },
  { document: "Stopped working after a week and support never answered my emails.", expected: "negative" },
  { document: "It does what it says. Nothing special, nothing wrong.", expected: "neutral" },
  { document: "Setup took two minutes and it has been flawless since.", expected: "positive" },
  { document: "Arrived scratched, the strap broke on day one. Returning it.", expected: "negative" },
  { document: "Works fine for the price, though I expected a bit more from the speakers.", expected: "neutral" },
];

console.log(`model: ${modelPath}`);
const bonsai = new MinionInferenceRuntime(() => modelPath, { gpuLayers });
const loadStart = performance.now();
await bonsai.decideChoice("warmup", INSTRUCTION, CRITERIA); // loads the model and decision context
console.log(`loaded in ${((performance.now() - loadStart) / 1000).toFixed(2)}s\n`);

const results: {
  document: string;
  expected: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  correct: boolean;
  ms: number;
}[] = [];

for (const { document, expected } of CASES) {
  const started = performance.now();
  const decision = await bonsai.decideChoice(document, INSTRUCTION, CRITERIA);
  const ms = performance.now() - started;
  const correct = decision.choice === expected;
  results.push({ document, expected, choice: decision.choice, confidence: decision.confidence, probabilities: decision.probabilities, correct, ms });
  const probabilities = Object.entries(decision.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([choice, p]) => `${choice} ${(p * 100).toFixed(1)}%`)
    .join("  ");
  console.log(`${correct ? "ok  " : "MISS"} ${document}`);
  console.log(`     expected ${expected}, got ${decision.choice} (confidence ${decision.confidence.toFixed(3)}, ${(ms / 1000).toFixed(2)}s)`);
  console.log(`     ${probabilities}\n`);
}
await bonsai.dispose();

const correct = results.filter((r) => r.correct).length;
const summary = {
  cases: results.length,
  correct,
  accuracy: correct / results.length,
  meanConfidence: results.reduce((sum, r) => sum + r.confidence, 0) / results.length,
  meanMs: results.reduce((sum, r) => sum + r.ms, 0) / results.length,
};
await writeFile(join(outDir, "scoring.json"), `${JSON.stringify({ instruction: INSTRUCTION, criteria: CRITERIA, summary, results }, null, 2)}\n`);
console.log(
  `accuracy ${correct}/${results.length} (${(summary.accuracy * 100).toFixed(0)}%), mean confidence ${summary.meanConfidence.toFixed(3)}, ` +
    `mean ${(summary.meanMs / 1000).toFixed(2)}s per case`,
);
console.log(`wrote ${join(outDir, "scoring.json")}`);
