// Runs with Bun during test.
import { afterEach, expect, it, vi } from "vitest";
import {
  audioBytes,
  audioUrl,
  decodeVoiceTestPcm,
  parseVoiceTestResult,
  synthesizeVoiceTest,
} from "./voice-test-api";

const RESULT = {
  translatedText: "bonjour",
  targetLanguage: "fr",
  audioBase64: "UklGRg==",
  contentType: "audio/wav",
  translationModel: "@cf/meta/m2m100-1.2b",
  ttsModel: "fish-audio/s2.1-pro-free",
};

afterEach(() => vi.unstubAllGlobals());

it("parses voice test output and reconstructs audio", () => {
  expect(parseVoiceTestResult(RESULT)).toStrictEqual(RESULT);
  expect(Array.from(audioBytes(RESULT.audioBase64))).toStrictEqual([82, 73, 70, 70]);
  const createObjectURL = vi.fn(() => "blob:test");
  vi.stubGlobal("URL", { createObjectURL });
  expect(audioUrl(RESULT)).toBe("blob:test");
  expect(createObjectURL).toHaveBeenCalledOnce();
});

it("decodes and resamples synthesized audio to 16 kHz mono PCM", async () => {
  const close = vi.fn(() => Promise.resolve());
  const connect = vi.fn();
  const start = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      public close = close;
      public decodeAudioData = vi.fn(() => Promise.resolve({ duration: 0.001 }));
    },
  );
  vi.stubGlobal(
    "OfflineAudioContext",
    class {
      public destination = {};
      public createBufferSource = vi.fn(() => ({ buffer: null, connect, start }));
      public startRendering = vi.fn(() =>
        Promise.resolve({ getChannelData: () => new Float32Array([0.25, -0.5]) }),
      );
    },
  );
  await expect(decodeVoiceTestPcm(RESULT)).resolves.toStrictEqual(new Float32Array([0.25, -0.5]));
  expect(connect).toHaveBeenCalledOnce();
  expect(start).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("rejects malformed voice output", () => {
  expect(() => parseVoiceTestResult(null)).toThrow("response is invalid");
  expect(() => parseVoiceTestResult({ ...RESULT, translatedText: null })).toThrow(
    "missing translatedText",
  );
});

it("posts text for translation and speech synthesis", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(RESULT))),
  );
  await expect(
    synthesizeVoiceTest({ text: "hello", sourceLanguage: "en", targetLanguage: "fr" }),
  ).resolves.toStrictEqual(RESULT);
});

it("surfaces structured and fallback voice service failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ error: "missing key" }, { status: 503 }))),
  );
  await expect(
    synthesizeVoiceTest({ text: "hello", sourceLanguage: "en", targetLanguage: "fr" }),
  ).rejects.toThrow("missing key");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("bad", { status: 502 }))),
  );
  await expect(
    synthesizeVoiceTest({ text: "hello", sourceLanguage: "en", targetLanguage: "fr" }),
  ).rejects.toThrow("Voice test failed: 502");
});
