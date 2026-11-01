// Wire types for the OmniVoice example (https://huggingface.co/k2-fsa/OmniVoice).
// The upstream model is PyTorch-only, so this runs the omnivoice.cpp GGML port
// (https://github.com/ServeurpersoCom/omnivoice.cpp) instead: a single native
// `omnivoice-tts` binary plus two GGUF weight files that the app downloads
// into its own data folder. No Python, no server, no network port.

export type OmniVoiceMode = "auto" | "design" | "clone";

export type OmniVoiceRequest = {
  mode: OmniVoiceMode;
  text: string;
  /** design mode: comma-separated attributes, e.g. "female, low pitch, british accent". */
  instruct?: string;
  /** clone mode: decoded mono reference clip (Float32 little-endian, base64). */
  refPcm?: { base64: string; sampleRate: number };
  /** clone mode: transcript of the reference clip (required by omnivoice.cpp). */
  refText?: string;
  /** Language label, e.g. "English". */
  language?: string;
  steps?: number;
  /**
   * Reuse (and grow) a persistent voice reference for this request's design
   * tags, so repeated recordings share one voice. Ignored in clone mode, where
   * the caller already supplied the reference. Defaults to on in minion-voice.
   */
  useVoiceReference?: boolean;
};

export type OmniVoiceResponse =
  | { ok: true; wavBase64: string; ms: number; cached?: boolean }
  | { ok: false; error: string };

/** A stable, short fingerprint for long values (clone reference audio). */
export function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The voice settings that decide whether a cached recording for the same text
 * is still valid. The TTS cache key is the text itself; this fingerprint is
 * checked alongside it so changing the voice regenerates instead of returning
 * a recording in the wrong voice.
 */
export function omniVoiceFingerprint(
  request: Pick<OmniVoiceRequest, "mode" | "instruct" | "language" | "steps" | "refText" | "refPcm">,
): string {
  return [
    request.mode,
    request.instruct?.trim() ?? "",
    request.language?.trim() ?? "",
    request.steps ?? "",
    request.refText?.trim() ?? "",
    request.refPcm ? `${request.refPcm.sampleRate}:${hashString(request.refPcm.base64)}` : "",
  ].join("|");
}

/**
 * A voice reference is only useful in a roughly 10–15 second window (enough
 * prosody to clone, short enough for the model).
 */
export const VOICE_PROFILE_MIN_SECONDS = 10;
export const VOICE_PROFILE_MAX_SECONDS = 15;

/** The profile used when a request carries no design tags (auto mode). */
export const DEFAULT_VOICE_PROFILE_KEY = "auto";

/**
 * How far a recording's duration is from the ideal voice-reference window:
 * `0` when it lands inside the 10–15 s range, larger the further away it is.
 */
export function voiceProfileFit(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return Number.POSITIVE_INFINITY;
  if (durationSeconds < VOICE_PROFILE_MIN_SECONDS) return VOICE_PROFILE_MIN_SECONDS - durationSeconds;
  if (durationSeconds > VOICE_PROFILE_MAX_SECONDS) return durationSeconds - VOICE_PROFILE_MAX_SECONDS;
  return 0;
}

/**
 * Whether a freshly generated recording should replace the current reference
 * for its profile. Picks the clip closest to the ideal window and locks once a
 * recording lands inside it ("once that condition is met, don't change it").
 */
export function shouldReplaceVoiceReference(
  currentDurationSeconds: number | null,
  candidateDurationSeconds: number,
): boolean {
  if (currentDurationSeconds !== null && voiceProfileFit(currentDurationSeconds) === 0) return false;
  const candidateFit = voiceProfileFit(candidateDurationSeconds);
  if (candidateFit === 0) return true;
  const currentFit =
    currentDurationSeconds === null ? Number.POSITIVE_INFINITY : voiceProfileFit(currentDurationSeconds);
  return candidateFit < currentFit;
}

/**
 * The unique identifier of a voice profile: the customization tags the caller
 * chose, concatenated and normalized so "Female, Low Pitch" and
 * "female , low  pitch" share one reference recording. Tag order is ignored and
 * an empty tag list (auto mode) still gets its own default profile.
 */
export function voiceProfileKey(instruct: string | undefined): string {
  const tags = (instruct ?? "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, " "))
    .filter((tag) => tag.length > 0);
  return [...new Set(tags)].sort().join(",") || DEFAULT_VOICE_PROFILE_KEY;
}

/**
 * Decodes a RIFF/WAVE byte buffer (8/16/32-bit PCM or 32-bit float, any channel
 * count) into mono Float32 samples in [-1, 1]. Used to measure a recording's
 * duration and to persist it as a voice-clone reference.
 */
export function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let format = 1;
  let channels = 1;
  let sampleRate = 0;
  let bits = 16;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true) || 1;
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format code in the first two
      // bytes of its SubFormat GUID (1 = PCM, 3 = IEEE float).
      if (format === 0xfffe && size >= 40 && body + 26 <= bytes.length) {
        format = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, bytes.length - body);
      break;
    }
    offset = body + size + (size % 2); // RIFF chunks are word-aligned
  }
  if (dataOffset < 0 || sampleRate <= 0) return null;

  const bytesPerSample = Math.max(1, bits / 8);
  const frameCount = Math.floor(dataLength / (channels * bytesPerSample));
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOffset + (i * channels + c) * bytesPerSample;
      if (format === 3 && bits === 32) sum += view.getFloat32(p, true);
      else if (bits === 16) sum += view.getInt16(p, true) / 0x8000;
      else if (bits === 8) sum += (view.getUint8(p) - 128) / 128;
      else if (bits === 32) sum += view.getInt32(p, true) / 0x80000000;
    }
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

export type OmniVoiceProgressMessage = { file: string; percentage: number };

/** Pre-converted GGUFs (CC-BY-NC, same terms as the upstream weights). */
export const OMNIVOICE_GGUF_REPO = "https://huggingface.co/Serveurperso/OmniVoice-GGUF/resolve/main";
export const OMNIVOICE_WEIGHTS = [
  { slotId: "omnivoice-base", filename: "omnivoice-base-Q8_0.gguf" },
  { slotId: "omnivoice-codec", filename: "omnivoice-tokenizer-Q8_0.gguf" },
] as const;

/**
 * Arguments for `omnivoice-tts`, which reads the text from stdin. `refTextPath`
 * is a file holding the transcript and `refWavPath` the 16-bit WAV reference.
 */
export function buildTtsArgs(
  request: OmniVoiceRequest,
  paths: { model: string; codec: string; output: string; refWav?: string; refTextPath?: string },
): string[] {
  if (!request.text.trim()) throw new Error("Enter some text to synthesize.");
  const args = ["--model", paths.model, "--codec", paths.codec, "-o", paths.output];

  if (request.mode === "design") {
    const instruct = request.instruct?.trim();
    if (!instruct) throw new Error("Voice design needs at least one attribute, e.g. \"female, low pitch\".");
    args.push("--instruct", instruct);
  } else if (request.mode === "clone") {
    if (!paths.refWav) throw new Error("Voice cloning needs a reference audio clip.");
    if (!request.refText?.trim() || !paths.refTextPath) throw new Error("Voice cloning needs the reference clip's transcript.");
    args.push("--ref-wav", paths.refWav, "--ref-text", paths.refTextPath);
  }

  const language = request.language?.trim();
  if (language) args.push("--lang", language);
  if (request.steps !== undefined) args.push("--steps", String(Math.max(1, Math.round(request.steps))));
  return args;
}

/** Mono 16-bit PCM WAV file bytes from float samples in [-1, 1]. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const tag = (offset: number, s: string) => [...s].forEach((c, i) => (out[offset + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return out;
}
