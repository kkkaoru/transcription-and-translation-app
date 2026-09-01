// Runs with Bun in the Cloudflare Workers runtime.

const VOICE_TEST_PATH: string = "/api/voice-test";
const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";
const LANGUAGE_DETECTION_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const FISH_TTS_URL: string = "https://api.fish.audio/v1/tts";
const MAXIMUM_TEXT_LENGTH: number = 500;
const LANGUAGE_CODE: RegExp = /^[a-z]{2,3}$/u;

interface VoiceTestEnvironment {
  AI: {
    run(
      model: typeof TRANSLATION_MODEL,
      input: { text: string; source_lang: string; target_lang: string },
    ): Promise<unknown>;
    run(
      model: typeof LANGUAGE_DETECTION_MODEL,
      input: { messages: readonly { role: "system" | "user"; content: string }[]; max_tokens: 8 },
    ): Promise<unknown>;
  };
  FISH_AUDIO_API_KEY?: string;
}

interface VoiceTestRequest {
  text: string;
  targetLanguage: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseVoiceTestRequest = (value: unknown): VoiceTestRequest => {
  if (!isRecord(value)) throw new Error("Voice test request must be an object");
  const text: unknown = value.text;
  const targetLanguage: unknown = value.targetLanguage;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAXIMUM_TEXT_LENGTH) {
    throw new Error("Text must contain between 1 and 500 characters");
  }
  if (typeof targetLanguage !== "string" || !LANGUAGE_CODE.test(targetLanguage)) {
    throw new Error("Target language is invalid");
  }
  return { text: text.trim(), targetLanguage };
};

export const parseDetectedLanguage = (value: unknown): string => {
  if (!isRecord(value) || typeof value.response !== "string") {
    throw new Error("Workers AI language detection returned no result");
  }
  const response: string = value.response.trim().toLowerCase();
  const direct: RegExpMatchArray | null = response.match(
    /^(?:```(?:json|text)?\s*)?["'`]?(?<code>[a-z]{2,3})\b/u,
  );
  const labeled: RegExpMatchArray | null = response.match(
    /\b(?:language|code)(?:\s+is|\s*[:=])\s*["'`]?(?<code>[a-z]{2,3})\b/u,
  );
  const language: string | undefined = direct?.groups?.code ?? labeled?.groups?.code;
  if (language === undefined || !LANGUAGE_CODE.test(language)) {
    throw new Error("Workers AI language detection returned an invalid language code");
  }
  return language;
};

const detectedLanguage = async (
  input: VoiceTestRequest,
  env: VoiceTestEnvironment,
): Promise<string> =>
  parseDetectedLanguage(
    await env.AI.run(LANGUAGE_DETECTION_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Identify the dominant language of the user text. Return only its lowercase ISO 639-1 or ISO 639-3 code, with no punctuation or explanation.",
        },
        { role: "user", content: input.text },
      ],
      max_tokens: 8,
    }),
  );

const translatedText = async (
  input: VoiceTestRequest,
  sourceLanguage: string,
  env: VoiceTestEnvironment,
): Promise<string> => {
  if (sourceLanguage === input.targetLanguage) return input.text;
  const result: unknown = await env.AI.run(TRANSLATION_MODEL, {
    text: input.text,
    source_lang: sourceLanguage,
    target_lang: input.targetLanguage,
  });
  if (!isRecord(result) || typeof result.translated_text !== "string") {
    throw new Error("Workers AI translation returned no text");
  }
  return result.translated_text;
};

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize: number = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

export const handleVoiceTestRequest = async (
  request: Request,
  env: VoiceTestEnvironment,
): Promise<Response | undefined> => {
  if (new URL(request.url).pathname !== VOICE_TEST_PATH) return undefined;
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  let input: VoiceTestRequest;
  try {
    input = parseVoiceTestRequest(await request.json());
  } catch (error) {
    const message: string = error instanceof Error ? error.message : "Invalid voice test request";
    return Response.json({ error: message }, { status: 400 });
  }
  if (typeof env.FISH_AUDIO_API_KEY !== "string" || env.FISH_AUDIO_API_KEY.trim() === "") {
    return Response.json(
      { error: "FISH_AUDIO_API_KEY is not configured on this Worker" },
      { status: 503 },
    );
  }
  try {
    const sourceLanguage: string = await detectedLanguage(input, env);
    const translated: string = await translatedText(input, sourceLanguage, env);
    const fishResponse: Response = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FISH_AUDIO_API_KEY}`,
        "content-type": "application/json",
        model: "s2.1-pro-free",
      },
      body: JSON.stringify({
        text: translated,
        format: "wav",
        sample_rate: 16_000,
        normalize: true,
        latency: "balanced",
      }),
    });
    if (!fishResponse.ok) {
      return Response.json(
        { error: `Fish Audio returned HTTP ${String(fishResponse.status)}` },
        { status: 502 },
      );
    }
    const audio = new Uint8Array(await fishResponse.arrayBuffer());
    return Response.json({
      translatedText: translated,
      sourceLanguage,
      targetLanguage: input.targetLanguage,
      audioBase64: base64(audio),
      contentType: fishResponse.headers.get("content-type") ?? "audio/wav",
      translationModel: TRANSLATION_MODEL,
      ttsModel: "fish-audio/s2.1-pro-free",
    });
  } catch (error) {
    const message: string = error instanceof Error ? error.message : "Voice test failed";
    return Response.json({ error: message }, { status: 502 });
  }
};
