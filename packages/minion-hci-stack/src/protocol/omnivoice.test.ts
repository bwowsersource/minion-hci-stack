import { test } from "node:test";
import { expect } from "../../test/expect.ts";
import {
  DEFAULT_VOICE_PROFILE_KEY,
  buildTtsArgs,
  decodeWav,
  encodeWav16,
  shouldReplaceVoiceReference,
  voiceProfileFit,
  voiceProfileKey,
} from "./omnivoice.ts";

const paths = { model: "/m/base.gguf", codec: "/m/codec.gguf", output: "/tmp/o.wav" };

test("auto voice passes model, codec, output and tuning flags", () => {
  const args = buildTtsArgs({ mode: "auto", text: " Hello ", language: "English", steps: 16.4 }, paths);
  expect(args).toEqual(["--model", "/m/base.gguf", "--codec", "/m/codec.gguf", "-o", "/tmp/o.wav", "--lang", "English", "--steps", "16"]);
});

test("design mode requires and forwards the instruct string", () => {
  expect(() => buildTtsArgs({ mode: "design", text: "hi", instruct: "  " }, paths)).toThrow();
  const args = buildTtsArgs({ mode: "design", text: "hi", instruct: "female, low pitch" }, paths);
  expect(args[args.indexOf("--instruct") + 1]).toBe("female, low pitch");
});

test("clone mode requires a reference clip and its transcript", () => {
  expect(() => buildTtsArgs({ mode: "clone", text: "hi" }, paths)).toThrow();
  expect(() => buildTtsArgs({ mode: "clone", text: "hi" }, { ...paths, refWav: "/r.wav" })).toThrow();
  const args = buildTtsArgs(
    { mode: "clone", text: "hi", refText: "said this" },
    { ...paths, refWav: "/r.wav", refTextPath: "/r.txt" },
  );
  expect(args).toContain("--ref-wav");
  expect(args[args.indexOf("--ref-text") + 1]).toBe("/r.txt");
});

test("empty text is rejected", () => {
  expect(() => buildTtsArgs({ mode: "auto", text: "  " }, paths)).toThrow();
});

test("encodeWav16 writes a valid mono 16-bit header and clamps samples", () => {
  const wav = encodeWav16(new Float32Array([0, 1, -1, 2]), 24000);
  const view = new DataView(wav.buffer);
  expect(wav.length).toBe(44 + 8);
  expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint32(24, true)).toBe(24000);
  expect(view.getUint32(40, true)).toBe(8);
  expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
});

test("decodeWav round-trips encodeWav16 and reports the sample rate", () => {
  const wav = encodeWav16(new Float32Array([0, 0.5, -0.5, 1, -1]), 24000);
  const decoded = decodeWav(wav);
  expect(decoded).not.toBeNull();
  expect(decoded!.sampleRate).toBe(24000);
  expect(decoded!.samples.length).toBe(5);
  expect(decoded!.samples[1]!).toBeCloseTo(0.5, 4);
  expect(decoded!.samples[2]!).toBeCloseTo(-0.5, 4);
});

test("decodeWav rejects non-WAV bytes", () => {
  expect(decodeWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  expect(decodeWav(new Uint8Array(0))).toBeNull();
});

test("voiceProfileFit measures distance to the 10–15 second window", () => {
  expect(voiceProfileFit(12)).toBe(0);
  expect(voiceProfileFit(10)).toBe(0);
  expect(voiceProfileFit(15)).toBe(0);
  expect(voiceProfileFit(7)).toBe(3);
  expect(voiceProfileFit(20)).toBe(5);
  expect(voiceProfileFit(0)).toBe(Number.POSITIVE_INFINITY);
});

test("shouldReplaceVoiceReference picks the closest clip and locks once ideal", () => {
  // No reference yet: any duration is an improvement.
  expect(shouldReplaceVoiceReference(null, 3)).toBe(true);
  // Closer to the window wins.
  expect(shouldReplaceVoiceReference(4, 8)).toBe(true);
  expect(shouldReplaceVoiceReference(8, 4)).toBe(false);
  expect(shouldReplaceVoiceReference(20, 18)).toBe(true);
  // A clip inside the window always wins, then locks.
  expect(shouldReplaceVoiceReference(8, 12)).toBe(true);
  expect(shouldReplaceVoiceReference(12, 2)).toBe(false);
  expect(shouldReplaceVoiceReference(12, 14)).toBe(false);
});

test("voiceProfileKey concatenates and normalizes the design tags", () => {
  expect(voiceProfileKey("Female, Low Pitch")).toBe("female,low pitch");
  expect(voiceProfileKey("  female ,  low   pitch ")).toBe("female,low pitch");
  // Tag order does not matter, and duplicate/empty tags drop out.
  expect(voiceProfileKey("low pitch, female")).toBe(voiceProfileKey("female, low pitch"));
  expect(voiceProfileKey("female,,female")).toBe("female");
  // No tags, or an empty string, still resolves to one default profile.
  expect(voiceProfileKey("")).toBe(DEFAULT_VOICE_PROFILE_KEY);
  expect(voiceProfileKey(undefined)).toBe(DEFAULT_VOICE_PROFILE_KEY);
});
