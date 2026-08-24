/**
 * Profile-sharded warm AzooKey converter.
 *
 * This file runs with bun.
 */

import { DurableObject } from "cloudflare:workers";
import type { UserLexiconRpc } from "@caption-bridge/inference-server-core";
import {
  AZOOKEY_MODE,
  AZOOKEY_MODEL,
  AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
  type AzookeyConvertModel,
  type AzookeyMessage,
  AzookeyProtocolError,
  convertAzookeyMessage,
  createWasmConverter,
} from "./azookey.js";
import azookeyWasm from "./azookey-wasm.js";

export interface ProfileConversionInput {
  text: string;
  model: AzookeyConvertModel;
  leftContext: string;
  baseUrl: string;
  timeoutMs: number;
  zenzUpstreamMaxMs: number;
  zenzNPredict: number;
  fallbackTimeoutMs: number;
  useUserLexicon: boolean;
}

export interface ProfileConversionResult {
  text: string;
  model: AzookeyConvertModel;
  usedCompletion: boolean;
  modelFallback?: string;
}

export interface ProfileN5Result {
  text: string;
  elapsedMs: number;
}

export interface ProfileConverterRpc {
  warmProfile(baseUrl?: string): Promise<void>;
  rescoreProfile(text: string, baseUrl: string): Promise<ProfileN5Result>;
  convertProfile(input: ProfileConversionInput): Promise<ProfileConversionResult>;
}

interface ProfileConverterDoEnv {
  USER_LEXICON?: {
    getByName(name: string): UserLexiconRpc;
  };
  ZENZ_GGUF?: { fetch(request: Request): Promise<Response> };
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AZOOKEY_DICTIONARY_URL?: string;
}

export class ProfileConverterDO extends DurableObject<ProfileConverterDoEnv> {
  readonly #converter: ReturnType<typeof createWasmConverter>;

  public constructor(ctx: DurableObjectState, env: ProfileConverterDoEnv) {
    super(ctx, env);
    const dictionaryUrl = env.AZOOKEY_DICTIONARY_URL ?? "/azookey/system.azkdict.gz";
    this.#converter = createWasmConverter(azookeyWasm, dictionaryUrl, (input, init) => {
      if (!env.ASSETS) throw new Error("Profile converter assets binding is unavailable");
      const target =
        input instanceof Request
          ? new URL(input.url)
          : new URL(String(input), "https://assets.internal");
      const request =
        input instanceof Request ? new Request(target, input) : new Request(target, init);
      return env.ASSETS.fetch(request);
    });
  }

  public async warmProfile(baseUrl?: string): Promise<void> {
    const containerWarmup =
      baseUrl && this.env.ZENZ_GGUF
        ? this.env.ZENZ_GGUF.fetch(new Request(`${baseUrl}/warmup`)).then(async (response) => {
            await response.body?.cancel();
            if (!response.ok) {
              throw new Error(`Container warm-up returned ${String(response.status)}`);
            }
          })
        : Promise.resolve();
    await Promise.all([this.#converter.warmup?.("http"), containerWarmup]);
  }

  public async rescoreProfile(text: string, baseUrl: string): Promise<ProfileN5Result> {
    if (!this.env.ZENZ_GGUF) throw new Error("Profile converter Container binding is unavailable");
    const fetchN5 = (): Promise<Response> =>
      this.env.ZENZ_GGUF?.fetch(
        new Request(`${baseUrl}/n5/rescore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }),
      ) ?? Promise.reject(new Error("missing binding"));
    const first = await fetchN5();
    const retry = async (): Promise<Response> => {
      await first.body?.cancel();
      return fetchN5();
    };
    const response = first.ok ? first : await retry();
    if (!response.ok) throw new Error(`Input N5 LM returned ${String(response.status)}`);
    const payload: unknown = await response.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !("text" in payload) ||
      typeof payload.text !== "string"
    ) {
      throw new Error("Input N5 LM returned an invalid response");
    }
    return {
      text: payload.text,
      elapsedMs:
        "elapsedMs" in payload &&
        typeof payload.elapsedMs === "number" &&
        Number.isFinite(payload.elapsedMs)
          ? payload.elapsedMs
          : 0,
    };
  }

  public async convertProfile(input: ProfileConversionInput): Promise<ProfileConversionResult> {
    if (!this.env.ZENZ_GGUF) throw new Error("Profile converter Container binding is unavailable");
    const message: AzookeyMessage = {
      type: "azookey.convert",
      requestId: crypto.randomUUID(),
      source: "web-speech",
      language: "ja",
      sourceText: input.text,
      vibratoInput: input.text,
      mode: AZOOKEY_MODE,
      model: input.model,
      leftContext: input.leftContext || "前文なし",
    };
    const userLexicon =
      input.useUserLexicon && this.env.USER_LEXICON
        ? this.env.USER_LEXICON.getByName("hosted-compare")
        : undefined;
    const fetcher = (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const forwarded =
        request instanceof Request ? new Request(request, init) : new Request(request, init);
      return this.env.ZENZ_GGUF?.fetch(forwarded) ?? Promise.reject(new Error("missing binding"));
    };
    const converted = await convertAzookeyMessage(message, {
      converter: this.#converter,
      timeoutMs: input.timeoutMs,
      zenzUpstreamMaxMs: input.zenzUpstreamMaxMs,
      deferDictionaryUntilZenz: false,
      zenzNPredict: input.zenzNPredict,
      modelRoutes: { [input.model]: { baseUrl: input.baseUrl } },
      fetcher,
      ...(userLexicon ? { userLexicon } : {}),
      wsOrHttp: "http",
    }).catch(async (error: unknown) => {
      if (!(error instanceof AzookeyProtocolError) || error.code !== "conversion_timeout") {
        throw error;
      }
      const fallback = await convertAzookeyMessage(
        { ...message, model: AZOOKEY_MODEL },
        {
          converter: this.#converter,
          timeoutMs: input.fallbackTimeoutMs,
          fetcher,
          ...(userLexicon ? { userLexicon } : {}),
          wsOrHttp: "http",
        },
      );
      return {
        ...fallback,
        requestedModel: input.model,
        modelFallback: AZOOKEY_MODEL_FALLBACK_UPSTREAM_FAILED,
      };
    });
    return {
      text: converted.convertedText,
      model: converted.model,
      usedCompletion: converted.usedCompletion,
      ...(converted.modelFallback ? { modelFallback: converted.modelFallback } : {}),
    };
  }
}
