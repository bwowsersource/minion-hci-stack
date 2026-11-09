import { test } from "node:test";
import { expect } from "../../test/expect.ts";
import { base64ToFloat32, float32ToBase64, joinTranscript } from "./cactus.ts";

test("float32 <-> base64 round-trips exactly, including large buffers", () => {
  const small = new Float32Array([0, 0.5, -0.25, 1, -1, 1e-6]);
  expect(Array.from(base64ToFloat32(float32ToBase64(small)))).toEqual(Array.from(small));

  // 30 s at 16 kHz — bigger than any single fromCharCode argument list.
  const big = Float32Array.from({ length: 16_000 * 30 }, (_, i) => Math.sin(i / 50));
  const back = base64ToFloat32(float32ToBase64(big));
  expect(back.length).toBe(big.length);
  expect(back[12345]).toBe(big[12345]!);
});

test("a subarray view encodes only its own bytes", () => {
  const view = new Float32Array([9, 1, 2, 3]).subarray(1, 3);
  expect(Array.from(base64ToFloat32(float32ToBase64(view)))).toEqual([1, 2]);
});

test("joinTranscript appends the pending tail and normalizes spacing", () => {
  expect(joinTranscript(["hello"], "world")).toBe("hello world");
  expect(joinTranscript(["hello", "brave new"], " world ")).toBe("hello brave new world");
  expect(joinTranscript([], "solo")).toBe("solo");
  expect(joinTranscript(["only committed"], "")).toBe("only committed");
  expect(joinTranscript([], "")).toBe("");
});
