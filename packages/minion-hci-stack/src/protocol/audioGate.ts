// Lowers background sound in a recorded clip before transcription. A
// frame-wise downward expander: frames much quieter than the clip's own
// speech level (its 90th-percentile frame loudness) are attenuated, with a
// short hold and smoothed gain so word onsets/endings aren't clipped and
// nothing clicks. It cannot remove background that is as loud as the speech.

export type GateOptions = {
  /** Frames below this fraction of the speech level are attenuated. */
  ratio?: number;
  /** Attenuation applied to background frames, in dB (negative). */
  reductionDb?: number;
  frameSeconds?: number;
  holdSeconds?: number;
};

const SILENT_CLIP = 0.003;

/**
 * Voice-activity gate for the live stream. Until `speaking()` returns true,
 * blocks are held in a short rolling pre-roll instead of being fed to the
 * model; the first time it opens, the pre-roll is released so the first word
 * isn't clipped. This keeps keystrokes and background noise out of the
 * transcript — Whisper hallucinates words like "thank you" from them — while
 * the level meter still sees every block. Unlike `gateBackground`, it needs no
 * whole clip and works on the arbitrary read sizes the recorder delivers.
 */
export class StreamingVoiceGate {
  private preroll: Float32Array[] = [];
  private prerollCount = 0;
  private opened = false;

  constructor(
    private readonly sampleRate: number,
    private readonly options: { prerollSeconds?: number; speaking?: () => boolean } = {},
  ) {}

  /** Blocks to feed to the model now (the released pre-roll plus `samples`). */
  push(samples: Float32Array): Float32Array[] {
    if (this.opened || (this.options.speaking?.() ?? true)) {
      this.opened = true;
      const out = this.preroll;
      this.preroll = [];
      this.prerollCount = 0;
      out.push(samples);
      return out;
    }
    const prerollSeconds = this.options.prerollSeconds ?? 0.5;
    this.preroll.push(samples);
    this.prerollCount += samples.length;
    while (this.prerollCount > prerollSeconds * this.sampleRate && this.preroll.length > 0) {
      this.prerollCount -= this.preroll.shift()!.length;
    }
    return [];
  }

  /** True once any block has been released (i.e. speech has started). */
  get openedOnce(): boolean {
    return this.opened;
  }
}

export function gateBackground(samples: Float32Array, sampleRate: number, options: GateOptions = {}): Float32Array {
  const { ratio = 0.35, reductionDb = -18, frameSeconds = 0.02, holdSeconds = 0.1 } = options;
  const frame = Math.max(1, Math.round(frameSeconds * sampleRate));
  const frames = Math.ceil(samples.length / frame);
  if (frames === 0) return samples;

  const rmsByFrame = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * frame;
    const end = Math.min(samples.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
    rmsByFrame[f] = Math.sqrt(sum / (end - start));
  }
  const sorted = Array.from(rmsByFrame).sort((a, b) => a - b);
  const reference = sorted[Math.min(frames - 1, Math.floor(frames * 0.9))]!;
  if (reference < SILENT_CLIP) return samples; // nothing loud enough to anchor on

  const threshold = ratio * reference;
  const floorGain = 10 ** (reductionDb / 20);
  const holdFrames = Math.round(holdSeconds / frameSeconds);
  const attack = 1 - Math.exp(-1 / (0.005 * sampleRate)); // opens in ~5 ms
  const release = 1 - Math.exp(-1 / (0.08 * sampleRate)); // closes in ~80 ms

  const out = new Float32Array(samples.length);
  let gain = 1;
  let hold = 0;
  for (let f = 0; f < frames; f++) {
    if (rmsByFrame[f]! >= threshold) hold = holdFrames;
    const target = hold > 0 ? 1 : floorGain;
    if (hold > 0) hold--;
    const start = f * frame;
    const end = Math.min(samples.length, start + frame);
    for (let i = start; i < end; i++) {
      gain += (target - gain) * (target > gain ? attack : release);
      out[i] = samples[i]! * gain;
    }
  }
  return out;
}
