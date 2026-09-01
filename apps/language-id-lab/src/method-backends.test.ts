// Runs with Bun during test.
import { afterEach, expect, it, vi } from "vitest";
import {
  INFERENCE_METHODS,
  inferenceMethod,
  isContainerInferenceMethod,
  isInferenceMethod,
} from "./inference-methods";
import { handleVoiceTestRequest, parseVoiceTestRequest } from "./voice-test-backend";
import { handleWorkersAiLanguageRequest, parseNovaLanguage } from "./workers-ai-language";

const sessionRequest = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://lab.test${path}`, {
    ...init,
    headers: { "x-kotoba-session-id": "test-session", ...init.headers },
  });

afterEach(() => vi.unstubAllGlobals());

it("enumerates five inference methods and distinguishes stateless Workers AI", () => {
  expect(INFERENCE_METHODS).toHaveLength(5);
  expect(isInferenceMethod("nvidia-ambernet-standard")).toBe(true);
  expect(isInferenceMethod("other")).toBe(false);
  expect(isContainerInferenceMethod("speechbrain-ecapa-basic")).toBe(true);
  expect(isContainerInferenceMethod("workers-ai-nova-3")).toBe(false);
  expect(inferenceMethod("workers-ai-nova-3").tier).toBeNull();
});

it("defensively parses Nova language detection responses", () => {
  expect(
    parseNovaLanguage({
      results: { channels: [{ detected_language: "ja", language_confidence: 1.2 }] },
    }),
  ).toStrictEqual({ language: "ja", confidence: 1 });
  expect(
    parseNovaLanguage({
      results: { channels: [{ alternatives: [{ languages: ["en"], confidence: 0.8 }] }] },
    }),
  ).toStrictEqual({ language: "en", confidence: 0.8 });
  expect(parseNovaLanguage(null)).toStrictEqual({ language: "unknown", confidence: 0 });
  expect(parseNovaLanguage({ results: { channels: [{}] } })).toStrictEqual({
    language: "unknown",
    confidence: 0,
  });
  expect(
    parseNovaLanguage({ results: { channels: [{ alternatives: [{ languages: [] }] }] } }),
  ).toStrictEqual({ language: "unknown", confidence: 0 });
  expect(parseNovaLanguage({ results: { channels: [] } })).toStrictEqual({
    language: "unknown",
    confidence: 0,
  });
});

it("runs Workers AI language detection and exposes stateless lifecycle operations", async () => {
  const run = vi.fn(() =>
    Promise.resolve({
      results: { channels: [{ detected_language: "fr", language_confidence: 0.91 }] },
    }),
  );
  const environment = { AI: { run } };
  const samples = new Float32Array([0.1, -0.1, 0.2, -0.2]);
  const response = await handleWorkersAiLanguageRequest(
    sessionRequest("/api/language/workers-ai-nova-3/infer?at_ms=42&pattern=utterance", {
      method: "POST",
      body: samples.buffer,
    }),
    environment,
  );
  expect(response?.status).toBe(200);
  await expect(response?.json()).resolves.toMatchObject({
    stable_language: "fr",
    stable_confidence: 0.91,
    model: "@cf/deepgram/nova-3",
    pattern: "utterance",
  });
  expect(run).toHaveBeenCalledOnce();

  const health = await handleWorkersAiLanguageRequest(
    sessionRequest("/api/language/workers-ai-nova-3/health"),
    environment,
  );
  await expect(health?.json()).resolves.toMatchObject({ ok: true, provider: "workers-ai" });
  const release = await handleWorkersAiLanguageRequest(
    sessionRequest("/api/language/workers-ai-nova-3/release"),
    environment,
  );
  await expect(release?.json()).resolves.toMatchObject({ state: "stateless" });
  expect(
    await handleWorkersAiLanguageRequest(new Request("https://lab.test/not-language"), environment),
  ).toBeUndefined();
});

it("surfaces Workers AI provider failures as structured responses", async () => {
  const response = await handleWorkersAiLanguageRequest(
    sessionRequest("/api/language/workers-ai-nova-3/infer", {
      method: "POST",
      body: new Float32Array([0.1, -0.1]).buffer,
    }),
    { AI: { run: vi.fn(() => Promise.reject(new Error("provider unavailable"))) } },
  );
  expect(response?.status).toBe(502);
  await expect(response?.json()).resolves.toMatchObject({ error: "provider unavailable" });
});

it("rejects invalid Workers AI audio and session identifiers", async () => {
  const environment = { AI: { run: vi.fn(() => Promise.resolve({})) } };
  const missingSession = await handleWorkersAiLanguageRequest(
    new Request("https://lab.test/api/language/workers-ai-nova-3/infer"),
    environment,
  );
  expect(missingSession?.status).toBe(400);
  const invalidAudio = await handleWorkersAiLanguageRequest(
    sessionRequest("/api/language/workers-ai-nova-3/infer", {
      method: "POST",
      body: new Uint8Array([1, 2]),
    }),
    environment,
  );
  expect(invalidAudio?.status).toBe(400);
  const unknown = await handleWorkersAiLanguageRequest(
    sessionRequest("/api/language/workers-ai-nova-3/other"),
    environment,
  );
  expect(unknown?.status).toBe(404);
});

it("handles voice API routing and invalid request payloads", async () => {
  const environment = { AI: { run: vi.fn(() => Promise.resolve({})) } };
  expect(
    await handleVoiceTestRequest(new Request("https://lab.test/other"), environment),
  ).toBeUndefined();
  const method = await handleVoiceTestRequest(
    new Request("https://lab.test/api/voice-test"),
    environment,
  );
  expect(method?.status).toBe(405);
  const invalid = await handleVoiceTestRequest(
    new Request("https://lab.test/api/voice-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", sourceLanguage: "en", targetLanguage: "ja" }),
    }),
    environment,
  );
  expect(invalid?.status).toBe(400);
});

it("validates voice test text and language codes", () => {
  expect(
    parseVoiceTestRequest({ text: " hello ", sourceLanguage: "en", targetLanguage: "ja" }),
  ).toStrictEqual({ text: "hello", sourceLanguage: "en", targetLanguage: "ja" });
  expect(() => parseVoiceTestRequest(null)).toThrow("must be an object");
  expect(() =>
    parseVoiceTestRequest({ text: "", sourceLanguage: "en", targetLanguage: "ja" }),
  ).toThrow("between 1 and 500");
  expect(() =>
    parseVoiceTestRequest({ text: "hi", sourceLanguage: "english", targetLanguage: "ja" }),
  ).toThrow("Source language");
  expect(() =>
    parseVoiceTestRequest({ text: "hi", sourceLanguage: "en", targetLanguage: "japanese" }),
  ).toThrow("Target language");
});

it("translates text and returns Fish Audio bytes without exposing its secret", async () => {
  const translate = vi.fn(() => Promise.resolve({ translated_text: "こんにちは" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        }),
      ),
    ),
  );
  const response = await handleVoiceTestRequest(
    new Request("https://lab.test/api/voice-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", sourceLanguage: "en", targetLanguage: "ja" }),
    }),
    { AI: { run: translate }, FISH_AUDIO_API_KEY: "secret" },
  );
  expect(response?.status).toBe(200);
  await expect(response?.json()).resolves.toMatchObject({
    translatedText: "こんにちは",
    audioBase64: "UklGRg==",
    ttsModel: "fish-audio/s2.1-pro-free",
  });
  expect(translate).toHaveBeenCalledOnce();
});

it("skips translation for matching languages and reports Fish or translation failures", async () => {
  const translate = vi.fn(() => Promise.resolve({ translated_text: "unused" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("failed", { status: 429 }))),
  );
  const sameLanguage = await handleVoiceTestRequest(
    new Request("https://lab.test/api/voice-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", sourceLanguage: "en", targetLanguage: "en" }),
    }),
    { AI: { run: translate }, FISH_AUDIO_API_KEY: "secret" },
  );
  expect(sameLanguage?.status).toBe(502);
  expect(translate).not.toHaveBeenCalled();

  const translationFailure = await handleVoiceTestRequest(
    new Request("https://lab.test/api/voice-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", sourceLanguage: "en", targetLanguage: "ja" }),
    }),
    { AI: { run: vi.fn(() => Promise.resolve({})) }, FISH_AUDIO_API_KEY: "secret" },
  );
  expect(translationFailure?.status).toBe(502);
  await expect(translationFailure?.json()).resolves.toMatchObject({
    error: "Workers AI translation returned no text",
  });
});

it("makes the Fish Audio secret optional at deployment but explicit at runtime", async () => {
  const request = new Request("https://lab.test/api/voice-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", sourceLanguage: "en", targetLanguage: "ja" }),
  });
  const response = await handleVoiceTestRequest(request, {
    AI: { run: vi.fn(() => Promise.resolve({ translated_text: "こんにちは" })) },
  });
  expect(response?.status).toBe(503);
  await expect(response?.json()).resolves.toMatchObject({
    error: "FISH_AUDIO_API_KEY is not configured on this Worker",
  });
});
