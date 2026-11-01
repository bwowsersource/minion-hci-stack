// End-of-speech detection from microphone loudness, for the Voice Chat example.
// Fed one RMS level per recorder chunk (0..1), it:
//   1. calibrates the room's noise floor from the first few hundred ms,
//   2. waits for speech (level clearly above the floor for a moment),
//   3. tracks how loud the *user* is (a running average of their voiced levels), and
//   4. ends the turn once the level stays below a fraction of that for `stopDelaySeconds`.
// Because the end threshold is relative to the user's own level, a steadier,
// quieter source (a TV across the room) counts as silence. It cannot separate
// two sources of similar loudness; that needs speaker verification.

export type EndpointOptions = {
  /** How long the level must stay low before the turn ends. */
  stopDelaySeconds: number;
  /** Fraction (0..1) of the user's speech level below which audio counts as silence. */
  sensitivity: number;
  /** Give up (nobody spoke) after this long. */
  noSpeechTimeoutSeconds?: number;
  calibrationSeconds?: number;
  /** Level must stay above the start threshold this long to count as speech. */
  minSpeechSeconds?: number;
};

export type EndpointEvent = "none" | "end" | "no-speech";

/** What the detector currently believes; shown live in the Voice Chat panel for tuning. */
export type EndpointSnapshot = {
  /** Calibrated room noise level, or null while still calibrating. */
  floor: number | null;
  /** Level that counts as the start of speech. */
  startLevel: number | null;
  /** The user's tracked speaking level (0 until speech starts). */
  userLevel: number;
  /** Level below which audio counts as silence (null until speech starts). */
  endLevel: number | null;
  speaking: boolean;
  silentFor: number;
  stopDelay: number;
};

const MIN_FLOOR = 0.002;
const MAX_FLOOR = 0.02;
const MIN_START_LEVEL = 0.015;
const LEVEL_TIME_CONSTANT_SECONDS = 0.5;

export class SpeechEndpointer {
  private elapsed = 0;
  private calibration: number[] = [];
  private floor: number | null = null;
  private voicedFor = 0;
  private started = false;
  private userLevel = 0;
  private silentFor = 0;
  private done = false;

  constructor(private readonly options: EndpointOptions) {}

  /** True once the user has started talking. */
  get speaking(): boolean {
    return this.started;
  }

  snapshot(): EndpointSnapshot {
    const floor = this.floor;
    return {
      floor,
      startLevel: floor === null ? null : Math.max(floor * 3, MIN_START_LEVEL),
      userLevel: this.userLevel,
      endLevel: floor === null || !this.started ? null : Math.max(this.options.sensitivity * this.userLevel, floor * 2),
      speaking: this.started,
      silentFor: this.silentFor,
      stopDelay: this.options.stopDelaySeconds,
    };
  }

  /** Feed one chunk's RMS level and its duration; returns an event at most once, then stays "none". */
  push(level: number, seconds: number): EndpointEvent {
    if (this.done) return "none";
    this.elapsed += seconds;
    const { calibrationSeconds = 0.3, noSpeechTimeoutSeconds = 6, minSpeechSeconds = 0.25 } = this.options;

    if (this.floor === null) {
      this.calibration.push(level);
      if (this.elapsed < calibrationSeconds) return "none";
      const sorted = [...this.calibration].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      this.floor = Math.min(MAX_FLOOR, Math.max(MIN_FLOOR, median));
      return "none";
    }

    if (!this.started) {
      const startLevel = Math.max(this.floor * 3, MIN_START_LEVEL);
      this.voicedFor = level > startLevel ? this.voicedFor + seconds : 0;
      if (this.voicedFor >= minSpeechSeconds) {
        this.started = true;
        this.userLevel = level;
        this.silentFor = 0;
        return "none";
      }
      if (this.elapsed >= noSpeechTimeoutSeconds) {
        this.done = true;
        return "no-speech";
      }
      return "none";
    }

    const endLevel = Math.max(this.options.sensitivity * this.userLevel, this.floor * 2);
    if (level >= endLevel) {
      this.silentFor = 0;
      const alpha = 1 - Math.exp(-seconds / LEVEL_TIME_CONSTANT_SECONDS);
      this.userLevel += (level - this.userLevel) * alpha;
      return "none";
    }
    this.silentFor += seconds;
    if (this.silentFor >= this.options.stopDelaySeconds) {
      this.done = true;
      return "end";
    }
    return "none";
  }
}
