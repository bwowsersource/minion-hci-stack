import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MicCapture } from "../src/protocol/mic.ts";

/** A MicCapture whose recorder is test/fakeMic.ts: noise, then speech, then noise (s16le 16 kHz mono). */
export function fakeMicCapture(): MicCapture {
  const recorder = { name: "fake-mic", argv: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), "fakeMic.ts")] };
  return {
    findRecorder: () => ({ ok: true, recorder }),
    startRecording(rec, onSamples, onExit) {
      const proc = spawn(rec.argv[0]!, rec.argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
      let stopping = false;
      const done = (async () => {
        let carry: number | null = null;
        for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          let bytes = chunk;
          if (carry !== null) {
            const merged = new Uint8Array(bytes.length + 1);
            merged[0] = carry;
            merged.set(bytes, 1);
            bytes = merged;
            carry = null;
          }
          if (bytes.length % 2) carry = bytes[bytes.length - 1]!;
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length - (bytes.length % 2));
          const samples = new Float32Array(view.byteLength / 2);
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
          onSamples(samples);
        }
        if (!stopping) onExit("fake mic exited");
      })();
      return {
        recorder: rec,
        stop: async () => {
          stopping = true;
          proc.kill();
          await done.catch(() => {});
        },
      };
    },
  };
}
