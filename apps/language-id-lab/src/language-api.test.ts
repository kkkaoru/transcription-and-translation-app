// Runs with Bun during test.
import { afterEach, expect, it, vi } from "vitest";
import {
  inferLanguage,
  parseLanguageInference,
  releaseLanguageContainer,
  resetLanguageInference,
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
    enabled: true,
    mode: "responsive",
    candidate_language: null,
    llr: 0,
    accept_llr: 3,
    reject_llr: -1.5,
    state: "idle",
  },
  hysteresis: {
    stable_posterior: 0.81,
    enter_posterior: 0.72,
    retain_posterior: 0.42,
    state: "retaining",
    challenger_language: null,
    challenger_posterior: 0,
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
    sprt: {
      enabled: true,
      mode: "responsive",
      candidateLanguage: null,
      llr: 0,
      acceptLlr: 3,
      rejectLlr: -1.5,
      state: "idle",
    },
    hysteresis: {
      stablePosterior: 0.81,
      enterPosterior: 0.72,
      retainPosterior: 0.42,
      state: "retaining",
      challengerLanguage: null,
      challengerPosterior: 0,
    },
    quality: 0.95,
    speechSeconds: 2.4,
    inferenceMs: 37.2,
    model: "speechbrain/lang-id-voxlingua107-ecapa",
    pattern: "rolling-context",
    providerBilling: null,
  });
});

it("parses and validates Workers AI provider billing", () => {
  expect(
    parseLanguageInference({
      ...RESPONSE,
      provider_billing: {
        audio_seconds: 2.4,
        usd_per_audio_minute: 0.0052,
        estimated_usd: 0.000_208,
        transport: "regular-http",
      },
    }).providerBilling,
  ).toStrictEqual({
    audioSeconds: 2.4,
    usdPerAudioMinute: 0.0052,
    estimatedUsd: 0.000_208,
    transport: "regular-http",
  });
  expect(() => parseLanguageInference({ ...RESPONSE, provider_billing: null })).toThrow(
    "Provider billing is invalid",
  );
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
  expect(() =>
    parseLanguageInference({ ...RESPONSE, sprt: { ...RESPONSE.sprt, state: "waiting" } }),
  ).toThrow("SPRT state is invalid");
  expect(() =>
    parseLanguageInference({ ...RESPONSE, sprt: { ...RESPONSE.sprt, mode: "other" } }),
  ).toThrow("Decision mode is invalid");
  expect(() =>
    parseLanguageInference({
      ...RESPONSE,
      hysteresis: { ...RESPONSE.hysteresis, state: "waiting" },
    }),
  ).toThrow("Hysteresis state is invalid");
  expect(() =>
    parseLanguageInference({
      ...RESPONSE,
      hysteresis: { ...RESPONSE.hysteresis, challenger_language: 3 },
    }),
  ).toThrow("Hysteresis challenger language is invalid");
  expect(() => parseLanguageInference({ ...RESPONSE, pattern: "other" })).toThrow(
    "pattern is invalid",
  );
});

it("uploads exact float32 PCM bytes to the selected tier", async () => {
  const requestBodies: ArrayBuffer[] = [];
  const requestUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init: RequestInit | undefined) => {
      requestUrls.push(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      );
      if (init?.body instanceof ArrayBuffer) requestBodies.push(init.body);
      return Promise.resolve(Response.json(RESPONSE));
    }),
  );
  const result = await inferLanguage({
    samples: new Float32Array([0.25, -0.5]),
    capturedAtMs: 1000,
    method: "speechbrain-ecapa-standard",
    pattern: "utterance",
    sessionId: "session-1",
    decisionPolicy: { mode: "wald", falseSwitchProbability: 0.1, missedSwitchProbability: 0.2 },
  });
  expect(result.stableLanguage).toBe("ko");
  const requestUrl = new URL(requestUrls[0], "https://lab.test");
  expect(JSON.parse(requestUrl.searchParams.get("decision_policy") ?? "null")).toStrictEqual({
    mode: "wald",
    false_switch_probability: 0.1,
    missed_switch_probability: 0.2,
  });
  expect(requestBodies.length).toBe(1);
  expect(Array.from(new Float32Array(requestBodies[0]))).toStrictEqual([0.25, -0.5]);
});

it("accepts an utterance response with an active SPRT candidate", () => {
  const parsed = parseLanguageInference({
    ...RESPONSE,
    pattern: "utterance",
    sprt: { ...RESPONSE.sprt, candidate_language: "ja", state: "accumulating" },
    hysteresis: {
      ...RESPONSE.hysteresis,
      state: "challenged",
      challenger_language: "ja",
      challenger_posterior: 0.998,
    },
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
      method: "speechbrain-ecapa-basic",
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
      method: "speechbrain-ecapa-basic",
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
  await warmLanguageContainer({ method: "speechbrain-ecapa-basic", sessionId: "session-1" });
  await resetLanguageInference({ method: "workers-ai-nova-3", sessionId: "session-1" });
  await releaseLanguageContainer({ method: "nvidia-ambernet-standard", sessionId: "session-1" });
  expect(requests[0].input).toBe("/api/language/speechbrain-ecapa-basic/warmup");
  expect(requests[1].input).toBe("/api/language/workers-ai-nova-3/reset");
  expect(requests[2].input).toBe("/api/language/nvidia-ambernet-standard/release");
  expect(requests[2].init?.keepalive).toBe(true);

  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ error: "unavailable" }, { status: 503 }))),
  );
  await expect(
    warmLanguageContainer({ method: "workers-ai-nova-3", sessionId: "session-1" }),
  ).rejects.toThrow("unavailable");
  await expect(
    resetLanguageInference({ method: "workers-ai-nova-3", sessionId: "session-1" }),
  ).rejects.toThrow("unavailable");
  await expect(
    releaseLanguageContainer({ method: "nvidia-ambernet-standard", sessionId: "session-1" }),
  ).rejects.toThrow("unavailable");
});
