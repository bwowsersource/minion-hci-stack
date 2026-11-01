import { expect, test } from "bun:test";
import { gateBackground, StreamingVoiceGate } from "./audioGate";

const RATE = 16_000;

function tone(seconds: number, amplitude: number): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin((2 * Math.PI * 300 * i) / RATE));
}

function rms(samples: Float32Array): number {
  return Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

test("quiet background around loud speech is attenuated, speech is kept", () => {
  const clip = concat(tone(1, 0.03), tone(1, 0.3), tone(1, 0.03));
  const out = gateBackground(clip, RATE);
  expect(out.length).toBe(clip.length);
  const speech = out.subarray(RATE * 1.2, RATE * 1.8);
  const lead = out.subarray(Math.round(RATE * 0.3), Math.round(RATE * 0.8));
  const tail = out.subarray(Math.round(RATE * 2.4), Math.round(RATE * 2.9));
  expect(rms(speech)).toBeCloseTo(rms(clip.subarray(RATE * 1.2, RATE * 1.8)), 2);
  expect(rms(lead)).toBeLessThan(0.03 * 0.707 * 0.2);
  expect(rms(tail)).toBeLessThan(0.03 * 0.707 * 0.2);
});

test("a near-silent clip is returned unchanged", () => {
  const clip = tone(1, 0.001);
  expect(gateBackground(clip, RATE)).toBe(clip);
});

test("a uniformly loud clip is left (almost) untouched", () => {
  const clip = tone(1, 0.2);
  expect(rms(gateBackground(clip, RATE))).toBeCloseTo(rms(clip), 2);
});

test("empty input is fine", () => {
  const empty = new Float32Array(0);
  expect(gateBackground(empty, RATE)).toBe(empty);
});

test("streaming gate drops non-speech until the endpointer opens", () => {
  let speaking = false;
  const gate = new StreamingVoiceGate(RATE, { speaking: () => speaking });
  const block = () => tone(0.1, 0.1);
  for (let i = 0; i < 10; i++) expect(gate.push(block())).toEqual([]); // 1 s quiet, capped to a 0.5 s pre-roll
  expect(gate.openedOnce).toBe(false);
  speaking = true;
  const released = gate.push(block());
  // The released pre-roll (0.5 s) plus the block that opened the gate.
  expect(released.length).toBe(6);
  expect(gate.openedOnce).toBe(true);
});

test("streaming gate needs no endpointer input and passes everything", () => {
  const gate = new StreamingVoiceGate(RATE);
  const first = tone(0.1, 0.1);
  expect(gate.push(first)).toEqual([first]);
  expect(gate.openedOnce).toBe(true);
});

test("a short click is held then dropped, never released", () => {
  let speaking = false;
  const gate = new StreamingVoiceGate(RATE, { speaking: () => speaking });
  for (let i = 0; i < 20; i++) gate.push(tone(0.1, 0.004)); // quiet room
  gate.push(tone(0.1, 0.3)); // one keystroke
  expect(gate.openedOnce).toBe(false);
  expect(gate.push(tone(0.1, 0.004))).toEqual([]);
});
