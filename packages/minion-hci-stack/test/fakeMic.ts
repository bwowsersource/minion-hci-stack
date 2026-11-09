export {};
// Test stand-in for a microphone recorder: writes raw s16le 16 kHz mono PCM to
// stdout in real time. 0.5 s of room noise, 1.5 s of "speech", then room noise.
import { setTimeout as sleep } from "node:timers/promises";
const RATE = 16_000;
const CHUNK = 1600; // 100 ms
const started = Date.now();
let sent = 0;
for (;;) {
  const t = sent / RATE;
  const amplitude = t < 0.5 ? 0.004 : t < 2.0 ? 0.12 : 0.004;
  const buf = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < CHUNK; i++) buf.writeInt16LE(Math.round((Math.random() * 2 - 1) * amplitude * 32767), i * 2);
  process.stdout.write(buf);
  sent += CHUNK;
  const wait = started + (sent / RATE) * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
}
