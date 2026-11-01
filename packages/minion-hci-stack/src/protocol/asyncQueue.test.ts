import { describe, expect, test } from "bun:test";
import { AsyncQueue } from "./asyncQueue";

describe("AsyncQueue", () => {
  test("delivers queued and later items, then ends on close", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    const seen: number[] = [];
    const consumer = (async () => {
      for await (const n of queue) seen.push(n);
    })();
    queue.push(2);
    await Promise.resolve();
    queue.push(3);
    queue.close();
    await consumer;
    expect(seen).toEqual([1, 2, 3]);
  });

  test("ignores pushes after close", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);
    const seen: number[] = [];
    for await (const n of queue) seen.push(n);
    expect(seen).toEqual([]);
  });
});

