import { afterEach, describe, expect, it } from "vitest";
import {
  audioContextConstructor,
  getUserMediaErrorMessageJa,
  hasMediaRecorderSupport,
  isWorkersAiAsrCaptureSupported,
  openWorkersAiAsrMicrophone,
  WEB_SPEECH_UNSUPPORTED_JA,
  WORKERS_AI_ASR_MIC_DENIED_JA,
  WORKERS_AI_ASR_MIC_GENERIC_JA,
  WORKERS_AI_ASR_PREPARING_JA,
  WORKERS_AI_ASR_UNSUPPORTED_JA,
  wavFileFromPcmFloat32,
} from "./workers-ai-asr-support";

class FakeAudioContext {}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "AudioContext");
  Reflect.deleteProperty(globalThis, "MediaRecorder");
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("workers-ai-asr-support", () => {
  it("treats capture as unsupported without window, getUserMedia, or AudioContext", () => {
    expect(isWorkersAiAsrCaptureSupported()).toBe(false);
    expect(audioContextConstructor()).toBeUndefined();
    expect(hasMediaRecorderSupport()).toBe(false);
  });

  it("requires getUserMedia and AudioContext, not MediaRecorder", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { AudioContext: FakeAudioContext },
    });
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: FakeAudioContext,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => ({}) } },
    });
    expect(isWorkersAiAsrCaptureSupported()).toBe(true);
    expect(hasMediaRecorderSupport()).toBe(false);
    expect(audioContextConstructor()).toBe(FakeAudioContext);
  });

  it("accepts webkitAudioContext when standard AudioContext is missing", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { webkitAudioContext: FakeAudioContext },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => ({}) } },
    });
    expect(audioContextConstructor()).toBe(FakeAudioContext);
    expect(isWorkersAiAsrCaptureSupported()).toBe(true);
  });

  it("maps getUserMedia DOM errors to Japanese without leaking English-only copy", () => {
    const denied = new Error("Permission denied");
    denied.name = "NotAllowedError";
    expect(getUserMediaErrorMessageJa(denied)).toBe(
      "マイク許可が必要です。ブラウザの設定でマイクを許可してください",
    );
    const missing = new Error("Requested device not found");
    missing.name = "NotFoundError";
    expect(getUserMediaErrorMessageJa(missing)).toBe(
      "マイクが見つかりません。接続を確認してください",
    );
    const busy = new Error("Device in use");
    busy.name = "NotReadableError";
    expect(getUserMediaErrorMessageJa(busy)).toBe(
      "マイクを開始できません。他のアプリが使用中の可能性があります",
    );
    const constrained = new Error("Overconstrained");
    constrained.name = "OverconstrainedError";
    expect(getUserMediaErrorMessageJa(constrained)).toBe("この端末のマイク設定では録音できません");
    const insecure = new Error("SecurityError");
    insecure.name = "SecurityError";
    expect(getUserMediaErrorMessageJa(insecure)).toBe(
      "このページではマイクを使用できません（HTTPS が必要な場合があります）",
    );
    const aborted = new Error("Aborted");
    aborted.name = "AbortError";
    expect(getUserMediaErrorMessageJa(aborted)).toBe("マイクの開始が中断されました");
    expect(getUserMediaErrorMessageJa(new Error("permission denied"))).toBe(
      WORKERS_AI_ASR_MIC_DENIED_JA,
    );
    expect(getUserMediaErrorMessageJa(new Error("Permission denied"))).toBe(
      WORKERS_AI_ASR_MIC_DENIED_JA,
    );
    const unbound = new TypeError(
      "Can only call MediaDevices.getUserMedia on instances of MediaDevices",
    );
    expect(getUserMediaErrorMessageJa(unbound)).toBe(WORKERS_AI_ASR_MIC_GENERIC_JA);
    expect(getUserMediaErrorMessageJa(new Error("マイク音声の解析を開始できません"))).toBe(
      "マイク音声の解析を開始できません",
    );
    expect(getUserMediaErrorMessageJa("not an error")).toBe(WORKERS_AI_ASR_MIC_GENERIC_JA);
    expect(WORKERS_AI_ASR_UNSUPPORTED_JA).toContain("Cloudflare Workers AI ASR");
    expect(WORKERS_AI_ASR_PREPARING_JA).toContain("準備");
    expect(WEB_SPEECH_UNSUPPORTED_JA).toContain("Web Speech");
  });

  it("opens the microphone via MediaDevices.getUserMedia this-binding", async () => {
    await expect(openWorkersAiAsrMicrophone()).rejects.toThrow(WORKERS_AI_ASR_MIC_GENERIC_JA);
    const devices = {
      getUserMedia(this: unknown, constraints?: MediaStreamConstraints) {
        if (this !== devices) {
          return Promise.reject(
            new TypeError("Can only call MediaDevices.getUserMedia on instances of MediaDevices"),
          );
        }
        expect(constraints).toEqual({ audio: true });
        return Promise.resolve({ id: "ok" } as unknown as MediaStream);
      },
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: devices },
    });
    await expect(openWorkersAiAsrMicrophone()).resolves.toEqual({ id: "ok" });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { mediaDevices: {} },
    });
    await expect(openWorkersAiAsrMicrophone()).rejects.toThrow(WORKERS_AI_ASR_MIC_GENERIC_JA);
  });

  it("encodes float32 PCM as a WAV file", async () => {
    const wav = wavFileFromPcmFloat32(Float32Array.from([0, 0.5, -0.5, 1]), "clip.wav");
    expect(wav).toBeInstanceOf(File);
    expect(wav.name).toBe("clip.wav");
    expect(wav.type).toBe("audio/wav");
    const bytes = new Uint8Array(await wav.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(bytes.byteLength).toBeGreaterThan(44);
  });
});
