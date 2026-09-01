// Runs with Bun during build and test.

const MAXIMUM_INFERENCE_SAMPLES: number = 16_000 * 30;

export interface VoiceTestResult {
  translatedText: string;
  targetLanguage: string;
  audioBase64: string;
  contentType: string;
  translationModel: string;
  ttsModel: string;
}

interface VoiceTestInput {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredString = (value: Record<string, unknown>, key: string): string => {
  const field: unknown = value[key];
  if (typeof field !== "string") throw new Error(`Voice test response is missing ${key}`);
  return field;
};

export const parseVoiceTestResult = (value: unknown): VoiceTestResult => {
  if (!isRecord(value)) throw new Error("Voice test response is invalid");
  return {
    translatedText: requiredString(value, "translatedText"),
    targetLanguage: requiredString(value, "targetLanguage"),
    audioBase64: requiredString(value, "audioBase64"),
    contentType: requiredString(value, "contentType"),
    translationModel: requiredString(value, "translationModel"),
    ttsModel: requiredString(value, "ttsModel"),
  };
};

export const synthesizeVoiceTest = async (input: VoiceTestInput): Promise<VoiceTestResult> => {
  const response: Response = await fetch("/api/voice-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message: unknown = isRecord(payload) ? payload.error : null;
    throw new Error(
      typeof message === "string" ? message : `Voice test failed: ${response.status}`,
    );
  }
  return parseVoiceTestResult(payload);
};

export const audioBytes = (base64: string): Uint8Array => {
  const binary: string = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export const audioUrl = (result: VoiceTestResult): string => {
  const bytes: Uint8Array = audioBytes(result.audioBase64);
  return URL.createObjectURL(new Blob([ownedBuffer(bytes)], { type: result.contentType }));
};

export const decodeVoiceTestPcm = async (result: VoiceTestResult): Promise<Float32Array> => {
  const bytes: Uint8Array = audioBytes(result.audioBase64);
  const context = new AudioContext();
  try {
    const source: AudioBuffer = await context.decodeAudioData(ownedBuffer(bytes));
    const frameCount: number = Math.max(1, Math.ceil(source.duration * 16_000));
    const offline = new OfflineAudioContext(1, frameCount, 16_000);
    const node: AudioBufferSourceNode = offline.createBufferSource();
    node.buffer = source;
    node.connect(offline.destination);
    node.start();
    const rendered: AudioBuffer = await offline.startRendering();
    return rendered.getChannelData(0).slice(0, MAXIMUM_INFERENCE_SAMPLES);
  } finally {
    await context.close();
  }
};
