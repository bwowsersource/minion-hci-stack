import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "../test/expect.ts";
import { encodeWav16 } from "./protocol/omnivoice.ts";
import type { OmniVoiceRequest } from "./protocol/omnivoice.ts";
import { OmniVoiceManager } from "./omnivoice.ts";
import { configureStack } from "./config.ts";

type Internals = {
  considerVoiceProfile(key: string, tags: string, wav: Uint8Array, text: string): void;
  withVoiceProfile(request: OmniVoiceRequest): OmniVoiceRequest;
  loadVoiceProfile(key: string): { tags: string; text: string; durationSeconds: number; ideal: boolean } | null;
};

const KEY = "female,low pitch";
const TAGS = "female, low pitch";
const IDEAL = { mode: "design", text: "hello", instruct: TAGS, useVoiceReference: true } satisfies OmniVoiceRequest;

function seconds(s: number, sampleRate = 16000): Uint8Array {
  return encodeWav16(new Float32Array(Math.round(s * sampleRate)), sampleRate);
}

function withManager(run: (manager: OmniVoiceManager, internals: Internals) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "minion-hci-voice-profile-"));
  configureStack({ assetsDir: dir });
  try {
    const manager = new OmniVoiceManager(() => {});
    run(manager, manager as unknown as Internals);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("voice profiles: no reference leaves a design request untouched", () => {
  withManager((_manager, internals) => {
    expect(internals.withVoiceProfile(IDEAL)).toEqual(IDEAL);
  });
});

test("voice profiles: the first recording becomes the reference, later designs clone it", () => {
  withManager((_manager, internals) => {
    internals.considerVoiceProfile(KEY, TAGS, seconds(3), "hello");
    const reference = internals.loadVoiceProfile(KEY);
    expect(reference?.text).toBe("hello");
    expect(reference?.ideal).toBe(false);

    const effective = internals.withVoiceProfile(IDEAL);
    expect(effective.mode).toBe("clone");
    expect(effective.instruct).toBeUndefined();
    expect(effective.refText).toBe("hello");
    expect(effective.refPcm?.sampleRate).toBe(16000);
    expect(effective.refPcm?.base64.length).toBeGreaterThan(0);
  });
});

test("voice profiles: a clip closer to the 10–15 s window wins, inside the window it locks", () => {
  withManager((_manager, internals) => {
    internals.considerVoiceProfile(KEY, TAGS, seconds(2), "two");
    internals.considerVoiceProfile(KEY, TAGS, seconds(6), "six");
    expect(internals.loadVoiceProfile(KEY)?.text).toBe("six");

    internals.considerVoiceProfile(KEY, TAGS, seconds(12), "twelve");
    expect(internals.loadVoiceProfile(KEY)?.ideal).toBe(true);

    // Locked: neither a better-looking (14 s, still ideal) nor a worse clip moves it.
    internals.considerVoiceProfile(KEY, TAGS, seconds(14), "fourteen");
    internals.considerVoiceProfile(KEY, TAGS, seconds(1), "one");
    expect(internals.loadVoiceProfile(KEY)?.text).toBe("twelve");
  });
});

test("voice profiles: useVoiceReference=false never swaps in the stored reference", () => {
  withManager((_manager, internals) => {
    internals.considerVoiceProfile(KEY, TAGS, seconds(3), "hello");
    const designOnly: OmniVoiceRequest = { ...IDEAL, useVoiceReference: false };
    expect(internals.withVoiceProfile(designOnly)).toEqual(designOnly);
  });
});

test("voice profiles: different preference strings keep separate references", () => {
  withManager((_manager, internals) => {
    internals.considerVoiceProfile("female,low pitch", "female, low pitch", seconds(3), "low");
    internals.considerVoiceProfile("male,high pitch", "male, high pitch", seconds(4), "high");
    expect(internals.loadVoiceProfile("female,low pitch")?.text).toBe("low");
    expect(internals.loadVoiceProfile("male,high pitch")?.text).toBe("high");
  });
});
