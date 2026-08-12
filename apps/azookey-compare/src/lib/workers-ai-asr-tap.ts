import { rmsDbFromFloat32, WORKERS_AI_ASR_VAD_DEFAULTS } from "./workers-ai-asr-vad";

/** ScriptProcessor quantum. Must stay in the rendering graph or onaudioprocess never fires. */
export const PCM_TAP_BUFFER_SIZE = 4096;
/** Zero frames after this → dead tap (ScriptProcessor not pulled). */
export const PCM_TAP_DEAD_WATCHDOG_MS = 3_000;
/** Frames arrive but stay below the silence gate. */
export const PCM_TAP_SILENCE_WATCHDOG_MS = 8_000;

export const WORKERS_AI_ASR_TAP_DEAD_JA =
  "マイク音声が届いていません（PCM tap frame=0）。入力デバイスとページのミュートを確認してください";

export const WORKERS_AI_ASR_TAP_SILENCE_JA =
  "マイクは無音のままです。入力デバイスと音量を確認してください";

export type TapVadBackend = "silero" | "energy";

export type TapGain = {
  gain: { value: number };
  connect(node: unknown): void;
};

export type TapAudioContext<TGain extends TapGain = TapGain> = {
  destination: unknown;
  createGain(): TGain;
};

export type TapProcessor = {
  connect(node: unknown): void;
};

export type TapHealthSnapshot = {
  tapFrames: number;
  peakRmsDb: number;
  vadBackend: TapVadBackend;
  sileroError?: string;
};

export type TapWatchdogVerdict = {
  kind: "ok" | "dead" | "silence";
  message?: string;
};

/**
 * Keep ScriptProcessor in the audio rendering quantum without audible playback.
 * tap→destination or MediaStreamDestination can throw or play the mic.
 */
export const attachMutedScriptProcessorTap = <TGain extends TapGain>(
  tap: TapProcessor,
  audioContext: TapAudioContext<TGain>,
): TGain => {
  const gain = audioContext.createGain();
  gain.gain.value = 0;
  tap.connect(gain);
  gain.connect(audioContext.destination);
  return gain;
};

export const updateTapPeakRmsDb = (currentPeak: number, samples: ArrayLike<number>): number => {
  const rmsDb = rmsDbFromFloat32(samples);
  if (!Number.isFinite(currentPeak)) {
    return rmsDb;
  }
  if (!Number.isFinite(rmsDb)) {
    return currentPeak;
  }
  return Math.max(currentPeak, rmsDb);
};

export const tapHealthAfterWatchdog = (snapshot: TapHealthSnapshot): TapWatchdogVerdict => {
  if (snapshot.tapFrames <= 0) {
    return { kind: "dead", message: WORKERS_AI_ASR_TAP_DEAD_JA };
  }
  if (
    !Number.isFinite(snapshot.peakRmsDb) ||
    snapshot.peakRmsDb < WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb
  ) {
    return { kind: "silence", message: WORKERS_AI_ASR_TAP_SILENCE_JA };
  }
  return { kind: "ok" };
};

export const logTapWatchdog = (
  snapshot: TapHealthSnapshot,
  verdict: TapWatchdogVerdict,
  logger: Pick<Console, "error" | "warn"> = console,
): void => {
  const payload = {
    tapFrames: snapshot.tapFrames,
    peakRmsDb: snapshot.peakRmsDb,
    vadBackend: snapshot.vadBackend,
    ...(snapshot.sileroError ? { sileroError: snapshot.sileroError } : {}),
  };
  if (verdict.kind === "dead") {
    logger.error("Workers AI ASR PCM tap produced no frames", payload);
    return;
  }
  if (verdict.kind === "silence") {
    logger.warn("Workers AI ASR PCM tap has no speech energy", payload);
  }
};
