// Runs with Bun in the Cloudflare Workers runtime.
import type { EcapaPattern } from "./language-api";

const METHOD_PREFIX: string = "/api/language/workers-ai-nova-3/";
const SESSION_HEADER: string = "x-kotoba-session-id";
const SAMPLE_RATE: number = 16_000;
const MAXIMUM_BYTES: number = SAMPLE_RATE * 30 * Float32Array.BYTES_PER_ELEMENT;
const METHOD_MODEL = "@cf/deepgram/nova-3";

interface WorkersAiEnvironment {
  AI: {
    run(
      model: typeof METHOD_MODEL,
      input: {
        audio: { body: ReadableStream<Uint8Array>; contentType: "audio/wav" };
        detect_language: true;
        channels: 1;
        smart_format: false;
      },
    ): Promise<unknown>;
  };
}

interface NovaDetection {
  language: string;
  confidence: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedConfidence = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export const parseNovaLanguage = (value: unknown): NovaDetection => {
  if (!isRecord(value) || !isRecord(value.results) || !Array.isArray(value.results.channels)) {
    return { language: "unknown", confidence: 0 };
  }
  const channel: unknown = value.results.channels[0];
  if (!isRecord(channel)) return { language: "unknown", confidence: 0 };
  if (typeof channel.detected_language === "string") {
    return {
      language: channel.detected_language,
      confidence: boundedConfidence(channel.language_confidence),
    };
  }
  const alternatives: unknown = channel.alternatives;
  if (!Array.isArray(alternatives) || !isRecord(alternatives[0])) {
    return { language: "unknown", confidence: 0 };
  }
  const languages: unknown = alternatives[0].languages;
  if (Array.isArray(languages) && typeof languages[0] === "string") {
    return {
      language: languages[0],
      confidence: boundedConfidence(alternatives[0].confidence),
    };
  }
  return { language: "unknown", confidence: 0 };
};

const floatPcmToWav = (bytes: ArrayBuffer): Uint8Array => {
  const samples = new Float32Array(bytes);
  const output = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(output);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, output.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample: number = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32_768 : sample * 32_767, true);
  }
  return new Uint8Array(output);
};

const patternFromUrl = (url: URL): EcapaPattern =>
  url.searchParams.get("pattern") === "utterance" ? "utterance" : "rolling-context";

const timestampFromUrl = (url: URL): number => {
  const value: number = Number(url.searchParams.get("at_ms"));
  return Number.isFinite(value) && value >= 0 ? value : 0;
};

export const handleWorkersAiLanguageRequest = async (
  request: Request,
  env: WorkersAiEnvironment,
): Promise<Response | undefined> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(METHOD_PREFIX)) return undefined;
  const operation: string = url.pathname.slice(METHOD_PREFIX.length);
  const sessionId: string | null = request.headers.get(SESSION_HEADER);
  if (sessionId === null || !/^[A-Za-z0-9_-]{1,64}$/u.test(sessionId)) {
    return Response.json(
      { error: "A valid x-kotoba-session-id header is required" },
      { status: 400 },
    );
  }
  if (operation === "health" || operation === "warmup") {
    return Response.json({ ok: true, model: METHOD_MODEL, provider: "workers-ai" });
  }
  if (operation === "release") {
    return Response.json({ ok: true, state: "stateless", idleTimeout: null });
  }
  if (operation !== "infer" || request.method !== "POST") {
    return Response.json({ error: "Unknown Workers AI operation" }, { status: 404 });
  }
  const body: ArrayBuffer = await request.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > MAXIMUM_BYTES || body.byteLength % 4 !== 0) {
    return Response.json({ error: "Audio must be bounded float32 PCM" }, { status: 400 });
  }
  const wav: Uint8Array = floatPcmToWav(body);
  const wavBuffer = new ArrayBuffer(wav.byteLength);
  new Uint8Array(wavBuffer).set(wav);
  const audioBody: ReadableStream<Uint8Array> | null = new Response(wavBuffer).body;
  if (audioBody === null) {
    return Response.json({ error: "Could not stream WAV audio to Workers AI" }, { status: 500 });
  }
  const startedAt: number = performance.now();
  let result: unknown;
  try {
    result = await env.AI.run(METHOD_MODEL, {
      audio: { body: audioBody, contentType: "audio/wav" },
      detect_language: true,
      channels: 1,
      smart_format: false,
    });
  } catch (error) {
    const message: string = error instanceof Error ? error.message : "Workers AI request failed";
    return Response.json({ error: message }, { status: 502 });
  }
  const detection: NovaDetection = parseNovaLanguage(result);
  const probability = { language: detection.language, probability: detection.confidence };
  const atMs: number = timestampFromUrl(url);
  return Response.json({
    session_id: sessionId,
    stable_language: detection.language,
    stable_confidence: detection.confidence,
    raw_languages: [probability],
    hsmm: { duration_ticks: 0, transition_hazard: 0, posterior: [probability] },
    sprt: { candidate_language: null, llr: 0, accept_llr: 0, reject_llr: 0 },
    hysteresis: {
      stable_posterior: detection.confidence,
      enter_posterior: 0,
      retain_posterior: 0,
    },
    quality: detection.confidence,
    speech_seconds: body.byteLength / Float32Array.BYTES_PER_ELEMENT / SAMPLE_RATE,
    inference_ms: performance.now() - startedAt,
    model: METHOD_MODEL,
    pattern: patternFromUrl(url),
    observed_at_ms: atMs,
  });
};
