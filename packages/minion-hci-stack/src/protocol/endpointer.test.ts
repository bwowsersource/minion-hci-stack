import { expect, test } from "bun:test";
import { SpeechEndpointer } from "./endpointer";
import type { EndpointEvent } from "./endpointer";

/** Feeds `level` for `seconds` in 100 ms chunks; returns the first event and the time it fired. */
function feed(ep: SpeechEndpointer, level: number, seconds: number, clock: { t: number }): { event: EndpointEvent; at: number } | null {
  for (let i = 0; i < Math.round(seconds * 10); i++) {
    clock.t += 0.1;
    const event = ep.push(level, 0.1);
    if (event !== "none") return { event, at: clock.t };
  }
  return null;
}

test("ends 1.2 s after the user stops talking", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 1.2, sensitivity: 0.4 });
  const clock = { t: 0 };
  expect(feed(ep, 0.004, 0.5, clock)).toBeNull(); // quiet room
  expect(feed(ep, 0.12, 2, clock)).toBeNull(); // speaking
  expect(ep.speaking).toBe(true);
  const end = feed(ep, 0.004, 3, clock)!;
  expect(end.event).toBe("end");
  expect(end.at).toBeCloseTo(2.5 + 1.2, 0);
});

test("short pauses between words do not end the turn", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 1.2, sensitivity: 0.4 });
  const clock = { t: 0 };
  feed(ep, 0.004, 0.5, clock);
  for (let i = 0; i < 4; i++) {
    expect(feed(ep, 0.12, 1, clock)).toBeNull();
    expect(feed(ep, 0.004, 0.6, clock)).toBeNull();
  }
});

test("a steady background quieter than the user counts as silence", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 1.2, sensitivity: 0.4 });
  const clock = { t: 0 };
  feed(ep, 0.004, 0.5, clock);
  feed(ep, 0.12, 2, clock);
  expect(feed(ep, 0.03, 3, clock)!.event).toBe("end"); // 0.03 < 0.4 * 0.12
});

test("a background nearly as loud as the user keeps it going (known limit)", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 1.2, sensitivity: 0.4 });
  const clock = { t: 0 };
  feed(ep, 0.004, 0.5, clock);
  feed(ep, 0.12, 2, clock);
  expect(feed(ep, 0.09, 5, clock)).toBeNull();
});

test("gives up when nobody speaks", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 1.2, sensitivity: 0.4, noSpeechTimeoutSeconds: 6 });
  const clock = { t: 0 };
  const result = feed(ep, 0.004, 10, clock)!;
  expect(result.event).toBe("no-speech");
  expect(result.at).toBeCloseTo(6, 0);
});

test("a click shorter than the minimum speech time is not speech", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 1.2, sensitivity: 0.4 });
  const clock = { t: 0 };
  feed(ep, 0.004, 0.5, clock);
  feed(ep, 0.2, 0.1, clock);
  feed(ep, 0.004, 0.5, clock);
  expect(ep.speaking).toBe(false);
});

test("fires once, then stays quiet", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 0.5, sensitivity: 0.4 });
  const clock = { t: 0 };
  feed(ep, 0.004, 0.5, clock);
  feed(ep, 0.12, 1, clock);
  expect(feed(ep, 0.004, 1, clock)!.event).toBe("end");
  expect(feed(ep, 0.004, 1, clock)).toBeNull();
});

test("snapshot reports calibration, speech start and silence progress", () => {
  const ep = new SpeechEndpointer({ stopDelaySeconds: 1.2, sensitivity: 0.4 });
  const clock = { t: 0 };
  expect(ep.snapshot().floor).toBeNull();
  feed(ep, 0.004, 0.5, clock);
  expect(ep.snapshot().floor).toBeCloseTo(0.004, 3);
  expect(ep.snapshot().speaking).toBe(false);
  feed(ep, 0.12, 1, clock);
  const speaking = ep.snapshot();
  expect(speaking.speaking).toBe(true);
  expect(speaking.endLevel).toBeCloseTo(0.4 * speaking.userLevel, 3);
  feed(ep, 0.004, 0.5, clock);
  expect(ep.snapshot().silentFor).toBeCloseTo(0.5, 1);
});
