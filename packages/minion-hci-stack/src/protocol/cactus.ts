// Wire types for the cactus-needle examples. Both the models and the
// microphone live in the bun backend (src/bun/cactus.ts, micCapture.ts): the
// webview's custom `views://` scheme can't start the package's module worker
// ("Could not load worker") and the system webview has no getUserMedia. The
// webview is just UI; only decoded audio *files* travel over RPC, as PCM.

import type { EndpointSnapshot } from "./endpointer.ts";

export type CactusLanguage = "en" | "de" | "fr" | "es" | "it" | "nl" | "pl";

export type CactusSpeechSettings = {
  language?: CactusLanguage;
  keywords?: string[];
  wordTimestamps?: boolean;
};

/** Mono Float32 samples as base64 of the raw little-endian bytes. */
export type CactusPcm = { base64: string; sampleRate: number };

/**
 * Optional help for a microphone recording; the Cactus panel sends none, so its
 * behaviour is unchanged. Everything here is opt-in because the extra
 * CactusMicMessage kinds would otherwise reach callers that don't expect them.
 */
export type CactusRecordAssist = {
  /** Send an "endpoint" message when the loudest speaker stops (see shared/endpointer.ts). */
  autoStop?: { stopDelaySeconds: number; sensitivity: number };
  /** Send a "warning" message for each of the last 5 seconds before the clip limit. */
  warnBeforeLimit?: boolean;
  /** Attenuate background sound in the clip before transcribing (see shared/audioGate.ts). */
  lowerBackground?: boolean;
};

export type CactusCallRequest =
  | { op: "needle.load" }
  | { op: "needle.unload" }
  | { op: "needle.reset" }
  | { op: "needle.complete"; prompt: string }
  | { op: "needle.generate"; prompt: string; lightsOnly?: boolean }
  | { op: "needle.run"; prompt: string; maxSteps: number; strict: boolean }
  | { op: "needle.extract"; text: string; strict: boolean }
  | { op: "needle.embed"; texts: [string, string, string] }
  | { op: "needle.abort"; prompt: string }
  | { op: "whistle.load" }
  | { op: "whistle.unload" }
  | { op: "whistle.transcribe"; pcm: CactusPcm; settings: CactusSpeechSettings }
  /** Features of the most recent clip (microphone recording or transcribed file). */
  | { op: "whistle.embed" }
  | { op: "mic.check" }
  | { op: "whistle.recordStart"; assist?: CactusRecordAssist }
  /** Stops the microphone and throws the audio away (no transcription). */
  | { op: "whistle.recordCancel" }
  | { op: "whistle.recordStop"; settings: CactusSpeechSettings }
  /** Live transcription; `assist` mirrors `whistle.recordStart` (auto-stop, warnings, meter). */
  | { op: "whistle.streamStart"; settings: CactusSpeechSettings; assist?: CactusRecordAssist }
  | { op: "whistle.streamStop" };

export type CactusCallResponse =
  | { ok: true; value: unknown; /** The call ended the session; the next call reloads it. */ sessionClosed?: boolean }
  | { ok: false; error: string };

export type CactusProgressMessage = { model: "needle" | "whistle"; percentage: number | null };

/** Microphone activity, sent while a recording or live stream is running. */
export type CactusMicMessage =
  | { kind: "level"; target: "record" | "stream"; level: number; seconds: number; /** assist.autoStop only */ endpoint?: EndpointSnapshot }
  /** A recording hit Whistle's per-call limit; the UI should stop it. */
  | { kind: "limit" }
  /** The recorder process ended on its own (usually a permission or device error). */
  | { kind: "stopped"; error: string }
  /** assist.autoStop: the user finished talking. */
  | { kind: "endpoint" }
  /** assist.autoStop: nobody spoke within the timeout. */
  | { kind: "noSpeech" }
  /** assist.warnBeforeLimit: this many whole seconds remain before the clip limit. */
  | { kind: "warning"; secondsLeft: number };

export type CactusStreamMessage =
  | { kind: "part"; text: string; pending: string; language: string; received: number; passMs: number }
  | { kind: "end" }
  | { kind: "error"; error: string };

/**
 * Joins a live stream's committed text chunks with its mutable pending tail.
 * Shared by the backend (the final transcript `whistle.streamStop` returns) and
 * the webview (the partial shown while listening) so they always agree.
 */
export function joinTranscript(committed: readonly string[], pending: string): string {
  return [...committed, pending]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

export function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  // Chunked so String.fromCharCode never gets a call-stack-sized argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
}
