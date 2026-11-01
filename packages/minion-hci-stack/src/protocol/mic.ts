// What CactusManager needs from a microphone backend. The backend itself (a
// spawned ffmpeg/arecord, which needs the host app's ffmpeg setup) stays in the
// host app and is injected into CactusManager.

/** Whistle's input format: 16 kHz, mono. Every recorder is asked for it. */
export const MIC_SAMPLE_RATE = 16_000;

export type Recorder = { name: string; argv: string[] };

export type RecordingHandle = {
  recorder: Recorder;
  /** Stops the recorder and resolves once its output is fully delivered. */
  stop: () => Promise<void>;
};

export type MicCapture = {
  findRecorder(): { ok: true; recorder: Recorder } | { ok: false; error: string };
  /**
   * Starts a recorder. `onSamples` gets 16 kHz mono floats as they arrive;
   * `onExit` fires once if the process ends on its own (error text included
   * when there is one).
   */
  startRecording(recorder: Recorder, onSamples: (samples: Float32Array) => void, onExit: (error: string | null) => void): RecordingHandle;
};
