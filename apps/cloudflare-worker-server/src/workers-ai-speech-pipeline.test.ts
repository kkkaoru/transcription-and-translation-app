// This file runs with bun.
import { describe, expect, it, vi } from "vitest";
import {
  handleWorkersAiSpeechPipeline,
  type SpeechPipelineN5Result,
  WORKERS_AI_SPEECH_PIPELINE_ID,
  WORKERS_AI_SPEECH_PIPELINE_PATH,
  workersAiSpeechAsrPayload,
} from "./workers-ai-speech-pipeline.js";

const wavFile = (): File => {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, 2, true);
  return new File([bytes], "utterance.wav", { type: "audio/wav" });
};

const request = (language: string | null = "ja"): Request => {
  const form = new FormData();
  form.set("file", wavFile());
  if (language) form.set("language", language);
  form.set("segmentation", "client-silero-v1");
  form.set("conversionModel", "zenz-v3.2-xsmall-gguf");
  form.set("computeTier", "standard");
  form.set("containerModel", "xsmall");
  form.set("n5Lm", "off");
  return new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
    method: "POST",
    body: form,
  });
};

const asrRun = () =>
  Promise.resolve({
    results: { channels: [{ alternatives: [{ transcript: "きょうはいいてんき" }] }] },
  });

const identityVibrato = (text: string): Promise<string> => Promise.resolve(text);
const identityN5 = (text: string): Promise<SpeechPipelineN5Result> =>
  Promise.resolve({ text, model: "input_n5_lm_v1", elapsedMs: 1.5 });

const xsmallConvert = () =>
  Promise.resolve({
    text: "今日はいい天気",
    model: "zenz-v3.2-xsmall-gguf",
    usedCompletion: true,
  });

describe("Workers AI speech pipeline", () => {
  it("validates internal ASR payloads", () => {
    expect(workersAiSpeechAsrPayload({ text: "最小" })).toStrictEqual({
      text: "最小",
      reading: "最小",
      language: "und",
      model: "@cf/deepgram/nova-3",
    });
    expect(
      workersAiSpeechAsrPayload({
        text: "ええ",
        reading: "ええ",
        language: "ja",
        model: "@cf/openai/whisper-large-v3-turbo",
        requestedModel: "@cf/deepgram/nova-3",
        asrModelFallback: "nova-3-unexpected-language-script",
      }),
    ).toStrictEqual({
      text: "ええ",
      reading: "ええ",
      language: "ja",
      model: "@cf/openai/whisper-large-v3-turbo",
      requestedModel: "@cf/deepgram/nova-3",
      asrModelFallback: "nova-3-unexpected-language-script",
    });
    expect(() => workersAiSpeechAsrPayload(null)).toThrow(
      "Workers AI ASR response is missing text",
    );
  });

  it("returns ASR, N5, Vibrato, and AzooKey timings for the selected profile", async () => {
    const form = await request().formData();
    form.set("n5Lm", "on");
    const vibrato = vi.fn(() => Promise.resolve("きょうはいいてんき"));
    const rescoreN5 = vi.fn(
      (): Promise<SpeechPipelineN5Result> =>
        Promise.resolve({
          text: "きょうはいいてんき",
          model: "input_n5_lm_v1",
          elapsedMs: 4.25,
        }),
    );
    const convert = vi.fn(xsmallConvert);
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      { asrEnvironment: {}, run: vi.fn(asrRun), vibrato, rescoreN5, convert },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      convertedText: "今日はいい天気",
      pipeline: WORKERS_AI_SPEECH_PIPELINE_ID,
      containerProfile: { computeTier: "standard", modelSize: "xsmall", n5Mode: "on" },
      logs: [
        { stage: "asr", output: "きょうはいいてんき" },
        { stage: "vibrato", output: "きょうはいいてんき" },
        { stage: "n5_lm", elapsedMs: 4.25 },
        { stage: "azookey", output: "今日はいい天気" },
      ],
    });
    expect(rescoreN5).toHaveBeenCalledWith("きょうはいいてんき", {
      computeTier: "standard",
      modelSize: "xsmall",
      n5Mode: "on",
    });
    expect(convert).toHaveBeenCalledWith({
      text: "きょうはいいてんき",
      model: "zenz-v3.2-xsmall-gguf",
      leftContext: "",
      profile: { computeTier: "standard", modelSize: "xsmall", n5Mode: "on" },
      useUserLexicon: true,
    });
  });

  it("emits pipeline timings without recognized text", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato: identityVibrato,
      rescoreN5: identityN5,
      convert: vi.fn(xsmallConvert),
    });

    expect(response.status).toBe(200);
    expect(consoleLog).toHaveBeenCalledOnce();
    expect(consoleLog.mock.calls[0]?.[0]).toMatch("speech_pipeline_metrics");
    expect(consoleLog.mock.calls[0]?.[0]).toMatch('"asrModel":"@cf/deepgram/nova-3"');
    expect(consoleLog.mock.calls[0]?.[0]).not.toMatch("きょうはいいてんき");
    expect(consoleLog.mock.calls[0]?.[0]).not.toMatch("今日はいい天気");
    consoleLog.mockRestore();
  });

  it("bypasses the user lexicon only when the browser confirms it is empty", async () => {
    const form = await request().formData();
    form.set("userLexicon", "off");
    const convert = vi.fn(xsmallConvert);
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        asrEnvironment: {},
        run: vi.fn(asrRun),
        vibrato: identityVibrato,
        rescoreN5: identityN5,
        convert,
      },
    );
    expect(response.status).toBe(200);
    expect(convert).toHaveBeenCalledWith({
      text: "きょうはいいてんき",
      model: "zenz-v3.2-xsmall-gguf",
      leftContext: "",
      profile: { computeTier: "standard", modelSize: "xsmall", n5Mode: "off" },
      useUserLexicon: false,
    });
  });

  it("restarts conversion with corrected N5 text after a speculative mismatch", async () => {
    const form = await request().formData();
    form.set("n5Lm", "on");
    const convert = vi
      .fn()
      .mockResolvedValueOnce({
        text: "今日はいい天気",
        model: "zenz-v3.2-xsmall-gguf",
        usedCompletion: true,
      })
      .mockResolvedValueOnce({
        text: "おはようございます",
        model: "zenz-v3.2-xsmall-gguf",
        usedCompletion: true,
      });
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        asrEnvironment: {},
        run: vi.fn(asrRun),
        vibrato: identityVibrato,
        rescoreN5: () =>
          Promise.resolve({
            text: "おはようございます",
            model: "input_n5_lm_v1",
            elapsedMs: 2,
          }),
        convert,
      },
    );

    expect(response.status).toBe(200);
    expect(convert).toHaveBeenCalledTimes(2);
    expect(convert.mock.calls[0]?.[0].text).toBe("きょうはいいてんき");
    expect(convert.mock.calls[1]?.[0].text).toBe("おはようございます");
    expect(await response.json()).toMatchObject({
      n5Text: "おはようございます",
      convertedText: "おはようございます",
      logs: [{ stage: "asr" }, { stage: "vibrato" }, { stage: "n5_lm" }, { stage: "azookey" }],
    });
  });

  it("extracts a kana reading before applying N5 to a kanji ASR surface", async () => {
    const form = await request().formData();
    form.set("n5Lm", "on");
    const vibrato = vi.fn(() => Promise.resolve("きょうはいいてんき"));
    const rescoreN5 = vi.fn(identityN5);
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        asrEnvironment: {},
        run: vi.fn(() =>
          Promise.resolve({
            results: { channels: [{ alternatives: [{ transcript: "今日はいい天気" }] }] },
          }),
        ),
        vibrato,
        rescoreN5,
        convert: vi.fn(xsmallConvert),
      },
    );

    expect(response.status).toBe(200);
    expect(vibrato).toHaveBeenCalledWith("今日はいい天気", "ja");
    expect(rescoreN5).toHaveBeenCalledWith("きょうはいいてんき", {
      computeTier: "standard",
      modelSize: "xsmall",
      n5Mode: "on",
    });
    expect(await response.json()).toMatchObject({
      logs: [
        { stage: "asr", output: "今日はいい天気" },
        { stage: "vibrato", output: "きょうはいいてんき" },
        { stage: "n5_lm", input: "きょうはいいてんき" },
        { stage: "azookey", input: "きょうはいいてんき" },
      ],
    });
  });

  it("supports no GGUF while keeping optional N5 rescoring", async () => {
    const form = await request().formData();
    form.set("conversionModel", "none");
    form.set("containerModel", "small");
    form.set("computeTier", "basic");
    form.set("n5Lm", "on");
    const convert = vi.fn(xsmallConvert);
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        asrEnvironment: {},
        run: vi.fn(asrRun),
        vibrato: identityVibrato,
        rescoreN5: () =>
          Promise.resolve({ text: "今日はいい天気", model: "input_n5_lm_v1", elapsedMs: 3 }),
        convert,
      },
    );
    expect(await response.json()).toMatchObject({
      convertedText: "今日はいい天気",
      conversionModel: "none",
      usedCompletion: false,
      logs: [{ stage: "asr" }, { stage: "vibrato" }, { stage: "n5_lm", elapsedMs: 3 }],
    });
    expect(convert).not.toHaveBeenCalled();
  });

  it("omits language hints and all Japanese processing when language is unspecified", async () => {
    const run = vi.fn((model, input) => {
      expect(model).toBe("@cf/deepgram/nova-3");
      expect(input).not.toHaveProperty("language");
      return asrRun();
    });
    const vibrato = vi.fn(identityVibrato);
    const rescoreN5 = vi.fn(identityN5);
    const convert = vi.fn(xsmallConvert);
    const response = await handleWorkersAiSpeechPipeline(request(null), {
      asrEnvironment: {},
      run,
      vibrato,
      rescoreN5,
      convert,
    });
    expect(await response.json()).toMatchObject({
      language: "und",
      convertedText: "きょうはいいてんき",
      usedCompletion: false,
      logs: [{ stage: "asr" }],
    });
    expect(vibrato).not.toHaveBeenCalled();
    expect(rescoreN5).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it("runs ASR only for Japanese when both N5 and GGUF are off", async () => {
    const form = await request().formData();
    form.set("conversionModel", "none");
    form.set("n5Lm", "off");
    const vibrato = vi.fn(identityVibrato);
    const rescoreN5 = vi.fn(identityN5);
    const convert = vi.fn(xsmallConvert);
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      { asrEnvironment: {}, run: vi.fn(asrRun), vibrato, rescoreN5, convert },
    );
    expect(await response.json()).toMatchObject({
      conversionModel: "none",
      convertedText: "きょうはいいてんき",
      usedCompletion: false,
      logs: [{ stage: "asr" }],
    });
    expect(vibrato).not.toHaveBeenCalled();
    expect(rescoreN5).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it("validates profile fields before invoking paid ASR", async () => {
    const form = await request().formData();
    form.set("computeTier", "other");
    const run = vi.fn(asrRun);
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        asrEnvironment: {},
        run,
        vibrato: identityVibrato,
        rescoreN5: identityN5,
        convert: xsmallConvert,
      },
    );
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an invalid user-lexicon selector before paid ASR", async () => {
    const form = await request().formData();
    form.set("userLexicon", "invalid");
    const run = vi.fn(asrRun);
    const response = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: form,
      }),
      {
        asrEnvironment: {},
        run,
        vibrato: identityVibrato,
        rescoreN5: identityN5,
        convert: xsmallConvert,
      },
    );
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("bypasses Japanese stages for an explicit non-Japanese language", async () => {
    const vibrato = vi.fn(identityVibrato);
    const response = await handleWorkersAiSpeechPipeline(request("en"), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato,
      rescoreN5: vi.fn(identityN5),
      convert: vi.fn(xsmallConvert),
    });
    expect(await response.json()).toMatchObject({
      language: "en",
      usedCompletion: false,
      logs: [{ stage: "asr" }],
    });
    expect(vibrato).not.toHaveBeenCalled();
  });

  it("rejects an invalid conversion before ASR and forwards ASR upload errors", async () => {
    const invalidForm = await request().formData();
    invalidForm.set("conversionModel", "other");
    const run = vi.fn(asrRun);
    const invalid = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: invalidForm,
      }),
      {
        asrEnvironment: {},
        run,
        vibrato: identityVibrato,
        rescoreN5: identityN5,
        convert: xsmallConvert,
      },
    );
    expect(invalid.status).toBe(400);
    expect(run).not.toHaveBeenCalled();

    const missingFile = new FormData();
    missingFile.set("conversionModel", "none");
    missingFile.set("computeTier", "basic");
    missingFile.set("n5Lm", "off");
    const asrError = await handleWorkersAiSpeechPipeline(
      new Request(`https://worker.example${WORKERS_AI_SPEECH_PIPELINE_PATH}`, {
        method: "POST",
        body: missingFile,
      }),
      {
        asrEnvironment: {},
        run,
        vibrato: identityVibrato,
        rescoreN5: identityN5,
        convert: xsmallConvert,
      },
    );
    expect(asrError.status).toBe(400);
  });

  it("returns optional fallback metadata when supplied by a converter", async () => {
    const response = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato: identityVibrato,
      rescoreN5: identityN5,
      convert: () =>
        Promise.resolve({
          text: "辞書結果",
          model: "azookey-rust-wasm",
          usedCompletion: false,
          modelFallback: "upstream-failed",
        }),
    });
    expect(await response.json()).toMatchObject({
      modelFallback: "upstream-failed",
      usedCompletion: false,
    });
  });

  it("returns silence and processing failures without hidden fallback", async () => {
    const silence = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(() =>
        Promise.resolve({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }),
      ),
      vibrato: identityVibrato,
      rescoreN5: identityN5,
      convert: xsmallConvert,
    });
    expect(await silence.json()).toMatchObject({ convertedText: "", logs: [] });

    const failure = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato: identityVibrato,
      rescoreN5: identityN5,
      convert: () => Promise.reject(new Error("dictionary unavailable")),
    });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toStrictEqual({
      error: { code: "japanese_postprocessing_failed", message: "dictionary unavailable" },
    });

    const untypedFailure = await handleWorkersAiSpeechPipeline(request(), {
      asrEnvironment: {},
      run: vi.fn(asrRun),
      vibrato: identityVibrato,
      rescoreN5: identityN5,
      convert: () => Promise.reject("offline"),
    });
    expect(await untypedFailure.json()).toStrictEqual({
      error: { code: "japanese_postprocessing_failed", message: "Japanese post-processing failed" },
    });
  });
});
