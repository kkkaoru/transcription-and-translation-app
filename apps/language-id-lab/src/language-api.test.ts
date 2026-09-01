// Runs with Bun during test.
import { afterEach, expect, it, vi } from "vitest";
import {
  inferLanguage,
  parseLanguageInference,
  releaseLanguageContainer,
  warmLanguageContainer,
} from "./language-api";

const RESPONSE = {
  session_id: "session-1",
  stable_language: "ko",
  stable_confidence: 0.81,
  raw_languages: [{ language: "ko", probability: 0.9 }],
  hsmm: {
    duration_ticks: 4,
    transition_hazard: 0.12,
    posterior: [{ language: "ko", probability: 0.81 }],
  },
  sprt: {
    candidate_language: null,
    llr: 0,
    accept_llr: 3,
    reject_llr: -1.5,
  },
  hysteresis: {
    stable_posterior: 0.81,
    enter_posterior: 0.72,
    retain_posterior: 0.42,
  },
  quality: 0.95,
  speech_seconds: 2.4,
  inference_ms: 37.2,
  model: "speechbrain/lang-id-voxlingua107-ecapa",
  pattern: "rolling-context",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it("validates a multilingual Rust inference response", () => {
  expect(parseLanguageInference(RESPONSE)).toStrictEqual({
    sessionId: "session-1",
    stableLanguage: "ko",
    stableConfidence: 0.81,
    rawLanguages: [{ language: "ko", probability: 0.9 }],
    hsmm: {
      durationTicks: 4,
      transitionHazard: 0.12,
      posterior: [{ language: "ko", probability: 0.81 }],
    },
    sprt: { candidateLanguage: null, llr: 0, acceptLlr: 3, rejectLlr: -1.5 },
    hysteresis: { stablePosterior: 0.81, enterPosterior: 0.72, retainPosterior: 0.42 },
    quality: 0.95,
    speechSeconds: 2.4,
    inferenceMs: 37.2,
    model: "speechbrain/lang-id-voxlingua107-ecapa",
    pattern: "rolling-context",
  });
});

it("rejects malformed inference diagnostics", () => {
  expect(() => parseLanguageInference(null)).toThrow("response is invalid");
  expect(() => parseLanguageInference({ ...RESPONSE, hsmm: null })).toThrow("response is invalid");
  expect(() =>
    parseLanguageInference({
      ...RESPONSE,
      sprt: { ...RESPONSE.sprt, candidate_language: 3 },
    }),
  ).toThrow("candidate language is invalid");
  expect(() => parseLanguageInference({ ...RESPONSE, pattern: "other" })).toThrow(
    "pattern is invalid",
  );
});

it("uploads exact float32 PCM bytes to the selected tier", async () => {
  const requestBodies: ArrayBuffer[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string | URL | Request, init: RequestInit | undefined) => {
      if (init?.body instanceof ArrayBuffer) requestBodies.push(init.body);
      return Promise.resolve(Response.json(RESPONSE));
    }),
  );
  const result = await inferLanguage({
    samples: new Float32Array([0.25, -0.5]),
    capturedAtMs: 1000,
    tier: "standard",
    pattern: "utterance",
    sessionId: "session-1",
  });
  expect(result.stableLanguage).toBe("ko");
  expect(requestBodies.length).toBe(1);
  expect(Array.from(new Float32Array(requestBodies[0]))).toStrictEqual([0.25, -0.5]);
});

it("accepts an utterance response with an active SPRT candidate", () => {
  const parsed = parseLanguageInference({
    ...RESPONSE,
    pattern: "utterance",
    sprt: { ...RESPONSE.sprt, candidate_language: "ja" },
  });
  expect(parsed.pattern).toBe("utterance");
  expect(parsed.sprt.candidateLanguage).toBe("ja");
});

it("rejects malformed scalar and probability fields", () => {
  expect(() => parseLanguageInference({ ...RESPONSE, hysteresis: null })).toThrow(
    "Hysteresis diagnostics are invalid",
  );
  expect(() => parseLanguageInference({ ...RESPONSE, raw_languages: null })).toThrow(
    "probability list is invalid",
  );
  expect(() => parseLanguageInference({ ...RESPONSE, raw_languages: [null] })).toThrow(
    "probability is invalid",
  );
  expect(() =>
    parseLanguageInference({ ...RESPONSE, raw_languages: [{ probability: 0.5 }] }),
  ).toThrow("missing language");
  expect(() =>
    parseLanguageInference({ ...RESPONSE, raw_languages: [{ language: "ja", probability: null }] }),
  ).toThrow("missing probability");
  expect(() => parseLanguageInference({ ...RESPONSE, session_id: null })).toThrow(
    "missing session_id",
  );
  expect(() => parseLanguageInference({ ...RESPONSE, quality: Number.NaN })).toThrow(
    "missing quality",
  );
});

it("surfaces inference service errors with and without a JSON message", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ error: "model cold" }, { status: 503 }))),
  );
  await expect(
    inferLanguage({
      samples: new Float32Array([0.25]),
      capturedAtMs: 1,
      tier: "basic",
      pattern: "utterance",
      sessionId: "session-1",
    }),
  ).rejects.toThrow("model cold");

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("not-json", { status: 502 }))),
  );
  await expect(
    inferLanguage({
      samples: new Float32Array([0.25]),
      capturedAtMs: 1,
      tier: "basic",
      pattern: "utterance",
      sessionId: "session-1",
    }),
  ).rejects.toThrow("Request failed: 502");
});

it("warms and releases a session, and propagates lifecycle errors", async () => {
  const requests: Array<{ input: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init: RequestInit | undefined) => {
      requests.push({ input: String(input), init });
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
  await warmLanguageContainer({ tier: "basic", sessionId: "session-1" });
  await releaseLanguageContainer({ tier: "standard", sessionId: "session-1" });
  expect(requests[0].input).toBe("/api/language/basic/warmup");
  expect(requests[1].input).toBe("/api/language/standard/release");
  expect(requests[1].init?.keepalive).toBe(true);

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 }))),
  );
  await expect(warmLanguageContainer({ tier: "basic", sessionId: "session-1" })).rejects.toThrow(
    "unavailable",
  );
  await expect(
    releaseLanguageContainer({ tier: "standard", sessionId: "session-1" }),
  ).rejects.toThrow("unavailable");
});
