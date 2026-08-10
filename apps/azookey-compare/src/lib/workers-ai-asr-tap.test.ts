import { describe, expect, it, vi } from "vitest";
import {
  attachMutedScriptProcessorTap,
  logTapWatchdog,
  PCM_TAP_BUFFER_SIZE,
  PCM_TAP_DEAD_WATCHDOG_MS,
  PCM_TAP_SILENCE_WATCHDOG_MS,
  tapHealthAfterWatchdog,
  updateTapPeakRmsDb,
  WORKERS_AI_ASR_TAP_DEAD_JA,
  WORKERS_AI_ASR_TAP_SILENCE_JA,
} from "./workers-ai-asr-tap";
import { rmsDbFromFloat32, WORKERS_AI_ASR_VAD_DEFAULTS } from "./workers-ai-asr-vad";

class FakeGain {
  gain = { value: 1 };
  connections: unknown[] = [];
  connect(node: unknown): void {
    this.connections.push(node);
  }
}

class FakeTap {
  connections: unknown[] = [];
  connect(node: unknown): void {
    this.connections.push(node);
  }
}

class FakeContext {
  destination = { kind: "destination" as const };
  createdGains: FakeGain[] = [];
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.createdGains.push(gain);
    return gain;
  }
}

describe("workers-ai-asr-tap", () => {
  it("pins ScriptProcessor buffer and watchdog windows", () => {
    expect(PCM_TAP_BUFFER_SIZE).toBe(4096);
    expect(PCM_TAP_DEAD_WATCHDOG_MS).toBe(3_000);
    expect(PCM_TAP_SILENCE_WATCHDOG_MS).toBe(8_000);
    expect(WORKERS_AI_ASR_TAP_DEAD_JA).toMatch(/frame=0/);
    expect(WORKERS_AI_ASR_TAP_SILENCE_JA).toMatch(/無音/);
  });

  it("attaches tap→mute gain→AudioContext.destination, never tap→destination", () => {
    const tap = new FakeTap();
    const audioContext = new FakeContext();
    const gain = attachMutedScriptProcessorTap(tap, audioContext);
    expect(gain.gain.value).toBe(0);
    expect(tap.connections).toEqual([gain]);
    expect(tap.connections).not.toContain(audioContext.destination);
    expect(gain.connections).toEqual([audioContext.destination]);
  });

  it("tracks peak RMS and classifies dead tap vs silence vs ok", () => {
    expect(updateTapPeakRmsDb(Number.NEGATIVE_INFINITY, new Float32Array(32))).toBe(
      Number.NEGATIVE_INFINITY,
    );
    const loud = Float32Array.from({ length: 32 }, () => 0.5);
    const peak = updateTapPeakRmsDb(Number.NEGATIVE_INFINITY, loud);
    expect(peak).toBe(rmsDbFromFloat32(loud));
    expect(updateTapPeakRmsDb(peak, new Float32Array(32))).toBe(peak);
    expect(updateTapPeakRmsDb(0, loud)).toBe(0);
    expect(updateTapPeakRmsDb(-40, loud)).toBe(peak);

    expect(tapHealthAfterWatchdog({ tapFrames: 0, peakRmsDb: -20, vadBackend: "silero" })).toEqual({
      kind: "dead",
      message: WORKERS_AI_ASR_TAP_DEAD_JA,
    });
    expect(
      tapHealthAfterWatchdog({
        tapFrames: 12,
        peakRmsDb: Number.NEGATIVE_INFINITY,
        vadBackend: "energy",
      }),
    ).toEqual({ kind: "silence", message: WORKERS_AI_ASR_TAP_SILENCE_JA });
    expect(
      tapHealthAfterWatchdog({
        tapFrames: 12,
        peakRmsDb: WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb - 1,
        vadBackend: "silero",
      }),
    ).toEqual({ kind: "silence", message: WORKERS_AI_ASR_TAP_SILENCE_JA });
    expect(
      tapHealthAfterWatchdog({
        tapFrames: 4,
        peakRmsDb: WORKERS_AI_ASR_VAD_DEFAULTS.silenceGateDb,
        vadBackend: "silero",
      }),
    ).toEqual({ kind: "ok" });
  });

  it("logs tapFrames, peakRmsDb, vadBackend, and sileroError without secrets", () => {
    const error = vi.fn();
    const warn = vi.fn();
    const logger = { error, warn };
    logTapWatchdog(
      { tapFrames: 0, peakRmsDb: Number.NEGATIVE_INFINITY, vadBackend: "energy" },
      { kind: "dead", message: WORKERS_AI_ASR_TAP_DEAD_JA },
      logger,
    );
    expect(error).toHaveBeenCalledWith("Workers AI ASR PCM tap produced no frames", {
      tapFrames: 0,
      peakRmsDb: Number.NEGATIVE_INFINITY,
      vadBackend: "energy",
    });
    logTapWatchdog(
      {
        tapFrames: 40,
        peakRmsDb: -80,
        vadBackend: "silero",
        sileroError: "ORT tensor",
      },
      { kind: "silence", message: WORKERS_AI_ASR_TAP_SILENCE_JA },
      logger,
    );
    expect(warn).toHaveBeenCalledWith("Workers AI ASR PCM tap has no speech energy", {
      tapFrames: 40,
      peakRmsDb: -80,
      vadBackend: "silero",
      sileroError: "ORT tensor",
    });
    logTapWatchdog({ tapFrames: 8, peakRmsDb: -20, vadBackend: "silero" }, { kind: "ok" }, logger);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/Bearer|CF-Access|secret/i);
  });
});
