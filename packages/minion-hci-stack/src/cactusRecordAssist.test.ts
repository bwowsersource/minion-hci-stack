import { afterEach, expect, test } from "bun:test";
import type { CactusMicMessage } from "./protocol/cactus";
import { CactusManager } from "./cactus";
import { fakeMicCapture } from "../test/fakeMicCapture";


let manager: CactusManager | null = null;

afterEach(async () => {
  await manager?.call({ op: "whistle.recordCancel" });
  await manager?.dispose();
  manager = null;
});

test("assisted recording reports an endpoint after the speaker stops, and cancel stops the recorder", async () => {
  const messages: CactusMicMessage[] = [];
  manager = new CactusManager(() => {}, () => {}, (m) => messages.push(m), fakeMicCapture());

  const started = await manager.call({
    op: "whistle.recordStart",
    assist: { autoStop: { stopDelaySeconds: 1.2, sensitivity: 0.4 }, warnBeforeLimit: true },
  });
  expect(started.ok).toBe(true);

  const deadline = Date.now() + 8000;
  while (!messages.some((m) => m.kind === "endpoint") && Date.now() < deadline) await Bun.sleep(50);

  expect(messages.filter((m) => m.kind === "level").length).toBeGreaterThan(5);
  expect(messages.some((m) => m.kind === "endpoint")).toBe(true);
  expect(messages.filter((m) => m.kind === "endpoint").length).toBe(1);

  const cancelled = await manager.call({ op: "whistle.recordCancel" });
  expect(cancelled.ok).toBe(true);
  // A second start works, so the first recorder really was released.
  const again = await manager.call({ op: "whistle.recordStart" });
  expect(again.ok).toBe(true);
}, 15_000);
