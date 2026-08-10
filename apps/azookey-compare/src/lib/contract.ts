import {
  DEFAULT_VIBRATO_IPADIC_ASSET_PATH,
  VIBRATO_IPADIC_FEATURE_INDEX,
} from "@caption-bridge/dictionaries";
import type { ConverterModel } from "./converter-models";
import { CONVERTER_MODELS, DEFAULT_CONVERTER_MODEL, isConverterModel } from "./converter-models";

/**
 * Configuration shared by the comparison UI and the AzooKey Worker WebSocket client.
 *
 * This contract lives under the standalone comparison app. It is independent of
 * any desktop product settings.
 *
 * Historical wire labels (`worker-vibrato`, `vibratoInput`) are preserved for
 * Worker compatibility. The selected mode records where Vibrato and AzooKey
 * run: browser-complete stays in-page; worker-vibrato still uses inference.
 */

export const COMPARISON_CONFIG_SCHEMA_VERSION = 1 as const;

/**
 * Global the browser pre-pass probes when no explicit name is configured.
 *
 * Shared with the runtime loader so the configuration status text cannot drift
 * from the global the loader actually reads.
 */
export const DEFAULT_BROWSER_WASM_GLOBAL_NAME = "__AZOOKEY_VIBRATO_WASM__";
/** Browser-bundled wasm-bindgen glue emitted by `build-vibrato-wasm.mjs`. */
export const DEFAULT_BROWSER_WASM_MODULE_URL = "/vibrato/vibrato_wasm.js";
/** Browser-bundled IPADIC system.dic.zst used by the generated tokenizer. */
export const DEFAULT_BROWSER_WASM_DICTIONARY_URL = DEFAULT_VIBRATO_IPADIC_ASSET_PATH;
/** IPADIC's reading field (`feature[7]`); UniDic CWJ uses 20 instead. */
export const DEFAULT_BROWSER_WASM_FEATURE_INDEX = VIBRATO_IPADIC_FEATURE_INDEX;

export type ComparisonMode = "worker-vibrato" | "browser-vibrato";

export const COMPARISON_MODES = [
  "worker-vibrato",
  "browser-vibrato",
] as const satisfies readonly ComparisonMode[];

export type ComparisonAuthScheme = "none" | "bearer";

/** Authentication used by the Worker WebSocket endpoint.
 *
 * Browsers cannot add an arbitrary `Authorization` header to a WebSocket
 * handshake.  The token is therefore kept separate from the URL and is left
 * to the client transport to send using the endpoint's agreed mechanism.
 */
export interface ComparisonAuth {
  scheme: ComparisonAuthScheme;
  token?: string;
}

export interface ComparisonConfig {
  schemaVersion: typeof COMPARISON_CONFIG_SCHEMA_VERSION;
  mode: ComparisonMode;
  /** Converter used for kana→kanji on the Worker (`azookey-rust-wasm` or Zenzai). */
  converterModel: ConverterModel;
  websocketUrl: string;
  auth: ComparisonAuth;
  /** BCP-47 language tag for Web Speech and the convert payload. */
  language: string;
  /** Optional browser-side WASM module specifier; empty means use the global fallback. */
  browserWasmModuleUrl?: string;
  /** Compressed Vibrato system dictionary URL for generated tokenizer modules. */
  browserWasmDictionaryUrl?: string;
  /** Optional global converter name used by the browser pre-pass when no module URL is set. */
  browserWasmGlobalName?: string;
}

export type ComparisonConfigInput = {
  schemaVersion?: unknown;
  mode?: unknown;
  converterModel?: unknown;
  websocketUrl?: unknown;
  auth?: unknown;
  language?: unknown;
  browserWasmModuleUrl?: unknown;
  browserWasmDictionaryUrl?: unknown;
  browserWasmGlobalName?: unknown;
};

export interface ComparisonModeOption {
  value: ComparisonMode;
  label: string;
  description: string;
}

export const comparisonModeOptions: readonly ComparisonModeOption[] = [
  {
    value: "worker-vibrato",
    label: "Cloudflare Worker 依存（Vibrato もかな漢字も Cloudflare Worker（推論））",
    description:
      "Cloudflare Worker（推論）上で Vibrato（漢字があるときだけ IPADIC F[7]）と AzooKey かな漢字変換を続けて実行します。推論側 Vibrato 未設定時はブラウザ Vibrato で漢字読みを補います。",
  },
  {
    value: "browser-vibrato",
    label: "ブラウザ完結（Vibrato もかな漢字もブラウザ）",
    description:
      "ブラウザの Vibrato WASM と IPADIC で読みを取り、同じブラウザの AzooKey WASM でかな漢字変換します。/ws/azookey は呼びません。漢字がなければ読みはそのまま、漢字があれば F[7] でひらがな化します。プリパス必須で、モジュールも辞書も見つからなければ失敗します（Cloudflare Worker へはサイレントに落ちません）。",
  },
] as const;

/** Longer copy shown in the preprocessing-location help dialog. */
export const comparisonModeHelpSections: readonly {
  value: ComparisonMode;
  title: string;
  body: string;
}[] = [
  {
    value: "worker-vibrato",
    title: "Cloudflare Worker 依存",
    body: "漢字→読みも Cloudflare Worker（推論）に寄せます。VIBRATO_UPSTREAM_URL または VIBRATO_DICTIONARY_URL が必要で、未設定時はブラウザ Vibrato で読みだけ補います。かな漢字は推論 Cloudflare Worker の AzooKey WASM、または選択した Zenzai です。",
  },
  {
    value: "browser-vibrato",
    title: "ブラウザ完結",
    body: "ブラウザで Vibrato（/vibrato/vibrato_wasm.js と /vibrato/system.dic.zst）と AzooKey（/azookey/azookey.wasm と /azookey/system.azkdict.gz）を完結します。Zenzai モデルを選んだ場合も LOUDS 辞書（system.azkdict.gz）のみで、GGUF 推論は行いません。辞書/WASM が無いと失敗し、Cloudflare Worker へは切り替わりません。",
  },
] as const;

/** Uppercase alias kept for existing call sites / tests. */
export const COMPARISON_MODE_OPTIONS = comparisonModeOptions;

/** Short, user-facing explanations for the fields in the settings panel. */
export const comparisonConfigFieldDescriptions = {
  mode: "Choose Cloudflare Worker-dependent Vibrato+conversion, or the fully in-browser Vibrato+AzooKey path. Browser-complete never calls /ws/azookey.",
  converterModel:
    "Choose AzooKey WASM (browser-complete or Cloudflare Worker), Zenzai LOUDS dictionary in browser-complete, or Zenzai GGUF on the inference Cloudflare Worker when MODEL_ROUTES exposes those upstreams.",
  websocketUrl:
    "A ws:// or wss:// URL for the compare Cloudflare Worker AzooKey endpoint (local wrangler default: ws://127.0.0.1:8787/ws/azookey).",
  auth: "Optional Bearer credentials for the Cloudflare Worker. Keep tokens out of URLs and logs.",
  language: "BCP-47 language tag sent to the recognizer (for example, ja or en-US).",
  browserWasmModuleUrl:
    "Optional browser WASM glue module URL for the pre-pass. Leave empty only when a named global converter is injected.",
  browserWasmDictionaryUrl:
    "Compressed Vibrato system.dic.zst URL for the generated tokenizer (IPADIC reading field F[7]).",
  browserWasmGlobalName:
    "Optional global converter name for the browser pre-pass (defaults to the built-in global name).",
} as const;

/**
 * True when browser-mode has either a module URL or an explicit global name
 * that could supply the convert/transform/tokenize pre-pass.
 * Presence of a name alone does not guarantee the global is injected at runtime.
 */
export const hasBrowserWasmConfiguration = (
  config: Pick<
    ComparisonConfig,
    "browserWasmModuleUrl" | "browserWasmDictionaryUrl" | "browserWasmGlobalName"
  >,
): boolean => Boolean(config.browserWasmModuleUrl?.trim() || config.browserWasmGlobalName?.trim());

/** Plain-language status for the browser pre-pass configuration panel. */
export const browserWasmConfigurationStatus = (
  config: Pick<
    ComparisonConfig,
    "browserWasmModuleUrl" | "browserWasmDictionaryUrl" | "browserWasmGlobalName"
  >,
): string => {
  const moduleUrl = config.browserWasmModuleUrl?.trim() ?? "";
  const dictionaryUrl =
    config.browserWasmDictionaryUrl?.trim() || DEFAULT_BROWSER_WASM_DICTIONARY_URL;
  const globalName = config.browserWasmGlobalName?.trim() ?? "";
  const effectiveGlobalName = globalName || DEFAULT_BROWSER_WASM_GLOBAL_NAME;
  if (moduleUrl && globalName) {
    return `ブラウザ Vibrato WASM: globalThis.${effectiveGlobalName} が注入されている場合はそちらが優先され、未注入ならモジュール URL（${moduleUrl}）と IPADIC 辞書（${dictionaryUrl}、F[7]）を読み込みます。`;
  }
  if (moduleUrl) {
    return `ブラウザ Vibrato WASM: モジュール URL（${moduleUrl}）と IPADIC 辞書（${dictionaryUrl}、F[7]）を読み込みます。ただし globalThis.${effectiveGlobalName} が注入されている場合はそちらが優先されます。`;
  }
  if (globalName) {
    return `ブラウザ Vibrato WASM: globalThis.${effectiveGlobalName} が注入されている場合のみ実行します。未注入なら変換は失敗します（Cloudflare Worker のみにはなりません）。`;
  }
  return `ブラウザ Vibrato WASM: モジュール URL も global 名も未設定です。globalThis.${effectiveGlobalName} が注入されていればそれを使い、なければ変換は失敗します（Cloudflare Worker のみにはなりません）。`;
};

/** JSON Schema for persisted/transported comparison configuration. */
export const comparisonConfigSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AzooKey comparison configuration",
  type: "object",
  additionalProperties: false,
  required: ["mode", "converterModel", "websocketUrl", "auth", "language"],
  properties: {
    schemaVersion: { type: "integer", const: COMPARISON_CONFIG_SCHEMA_VERSION },
    mode: { type: "string", enum: [...COMPARISON_MODES] },
    converterModel: { type: "string", enum: [...CONVERTER_MODELS] },
    websocketUrl: { type: "string", pattern: "^wss?://" },
    auth: {
      type: "object",
      additionalProperties: false,
      required: ["scheme"],
      properties: {
        scheme: { type: "string", enum: ["none", "bearer"] },
        token: { type: "string", minLength: 1 },
      },
      oneOf: [
        {
          required: ["scheme"],
          properties: { scheme: { const: "none" } },
          not: { required: ["token"] },
        },
        {
          required: ["scheme", "token"],
          properties: { scheme: { const: "bearer" } },
        },
      ],
    },
    language: { type: "string", minLength: 1 },
    browserWasmModuleUrl: { type: "string", minLength: 1 },
    browserWasmDictionaryUrl: { type: "string", minLength: 1 },
    browserWasmGlobalName: { type: "string", minLength: 1 },
  },
} as const;

/**
 * Local wrangler default (`bun run --cwd apps/cloudflare-worker-server dev`).
 * Override with `NEXT_PUBLIC_AZOO_KEY_WORKER_WS_URL` for a deployed Worker.
 * Wire mode values remain `worker-vibrato` / `browser-vibrato` for the Worker contract.
 */
export const DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL = "ws://127.0.0.1:8787/ws/azookey";
/**
 * Browser comparison mode still uses the same AzooKey Worker for kana→kanji.
 * The browser WASM step is only a pre-pass before this endpoint.
 */
export const DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL = DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL;
export const DEFAULT_COMPARISON_LANGUAGE = "ja";
export const DEFAULT_COMPARISON_MODE: ComparisonMode = "worker-vibrato";

/** Worker is the comparison app's primary path; browser mode remains one select away. */
export const DEFAULT_COMPARISON_CONFIG: ComparisonConfig = {
  schemaVersion: COMPARISON_CONFIG_SCHEMA_VERSION,
  mode: DEFAULT_COMPARISON_MODE,
  converterModel: DEFAULT_CONVERTER_MODEL,
  websocketUrl: DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL,
  auth: { scheme: "none" },
  language: DEFAULT_COMPARISON_LANGUAGE,
  browserWasmModuleUrl: DEFAULT_BROWSER_WASM_MODULE_URL,
  browserWasmDictionaryUrl: DEFAULT_BROWSER_WASM_DICTIONARY_URL,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const isComparisonMode = (value: unknown): value is ComparisonMode =>
  typeof value === "string" && (COMPARISON_MODES as readonly string[]).includes(value);

const nonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
};

/** Return true only for a syntactically valid WebSocket URL. */
export const isVibratoWebSocketUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value.trim());
    return (
      (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
};

const WEBSOCKET_ROOT_PATH = "/";

const serializeWebSocketUrl = (parsed: URL): string =>
  parsed.pathname === WEBSOCKET_ROOT_PATH
    ? `${parsed.protocol}//${parsed.host}${parsed.search}${parsed.hash}`
    : parsed.toString();

const websocketUrl = (value: unknown, label = "websocketUrl"): string => {
  const candidate = nonEmptyString(value, label);
  if (!isVibratoWebSocketUrl(candidate)) {
    throw new Error(`${label} must be a ws:// or wss:// URL`);
  }
  const parsed = new URL(candidate);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return serializeWebSocketUrl(parsed);
};

const language = (value: unknown, label = "language"): string => nonEmptyString(value, label);

const optionalTrimmedString = (value: unknown, label: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when supplied`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const browserWasmModuleUrl = (value: unknown): string | undefined => {
  const candidate = optionalTrimmedString(value, "browserWasmModuleUrl");
  if (candidate && /^javascript:/i.test(candidate)) {
    throw new Error("browserWasmModuleUrl cannot use the javascript: scheme");
  }
  return candidate;
};

const browserWasmDictionaryUrl = (value: unknown): string | undefined => {
  const candidate = optionalTrimmedString(value, "browserWasmDictionaryUrl");
  if (candidate && /^javascript:/i.test(candidate)) {
    throw new Error("browserWasmDictionaryUrl cannot use the javascript: scheme");
  }
  return candidate;
};

const auth = (value: unknown, label = "auth"): ComparisonAuth => {
  if (typeof value === "string") {
    const token = value.trim();
    return token ? { scheme: "bearer", token } : { scheme: "none" };
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  const schemeValue = value["scheme"] ?? value["type"];
  const tokenValue = value["token"];
  if (schemeValue !== undefined && schemeValue !== "none" && schemeValue !== "bearer") {
    throw new Error(`${label}.scheme must be none or bearer`);
  }
  if (
    tokenValue !== undefined &&
    (typeof tokenValue !== "string" || tokenValue.trim().length === 0)
  ) {
    throw new Error(`${label}.token must be a non-empty string when supplied`);
  }
  const token = typeof tokenValue === "string" ? tokenValue.trim() : undefined;
  const scheme: ComparisonAuthScheme = schemeValue ?? (token ? "bearer" : "none");
  if (scheme === "none" && token) {
    throw new Error(`${label}.token cannot be supplied with the none scheme`);
  }
  if (scheme === "bearer" && !token) {
    throw new Error(`${label}.token is required for the bearer scheme`);
  }
  return scheme === "bearer" ? { scheme, token } : { scheme };
};

const schemaVersion = (value: unknown): typeof COMPARISON_CONFIG_SCHEMA_VERSION => {
  if (value !== undefined && value !== COMPARISON_CONFIG_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${COMPARISON_CONFIG_SCHEMA_VERSION}`);
  }
  return COMPARISON_CONFIG_SCHEMA_VERSION;
};

/**
 * Strictly validate and normalize a comparison configuration.
 * Missing schemaVersion is accepted for forward-compatible hand-authored
 * settings and is materialized as the current version in the result.
 */
export const validateComparisonConfig = (value: unknown): ComparisonConfig => {
  if (!isRecord(value)) {
    throw new Error("comparison config must be an object");
  }
  const mode = value["mode"];
  if (!isComparisonMode(mode)) {
    throw new Error("mode must be worker-vibrato or browser-vibrato");
  }
  const converterModelValue = value["converterModel"] ?? DEFAULT_CONVERTER_MODEL;
  if (!isConverterModel(converterModelValue)) {
    throw new Error("converterModel must be azookey-rust-wasm or a supported Zenzai id");
  }
  const browserModuleUrl = browserWasmModuleUrl(value["browserWasmModuleUrl"]);
  const browserDictionaryUrl = browserWasmDictionaryUrl(value["browserWasmDictionaryUrl"]);
  const browserGlobalName = optionalTrimmedString(
    value["browserWasmGlobalName"],
    "browserWasmGlobalName",
  );
  return {
    schemaVersion: schemaVersion(value["schemaVersion"]),
    mode,
    converterModel: converterModelValue,
    websocketUrl: websocketUrl(value["websocketUrl"]),
    auth: auth(value["auth"]),
    language: language(value["language"]),
    ...(browserModuleUrl ? { browserWasmModuleUrl: browserModuleUrl } : {}),
    ...(browserDictionaryUrl ? { browserWasmDictionaryUrl: browserDictionaryUrl } : {}),
    ...(browserGlobalName ? { browserWasmGlobalName: browserGlobalName } : {}),
  };
};

const defaultWebsocketUrl = (mode: ComparisonMode): string =>
  mode === "worker-vibrato"
    ? DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL
    : DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL;

/**
 * Merge user-provided settings with safe defaults. Invalid or incomplete
 * persisted values are ignored field-by-field rather than breaking the app at
 * startup; callers that need hard failures should use validateComparisonConfig.
 */
export const mergeComparisonConfig = (value: unknown): ComparisonConfig => {
  const input = isRecord(value) ? value : {};
  const mode = isComparisonMode(input["mode"]) ? input["mode"] : DEFAULT_COMPARISON_CONFIG.mode;
  const converterModel = isConverterModel(input["converterModel"])
    ? input["converterModel"]
    : DEFAULT_CONVERTER_MODEL;
  const candidateUrl = input["websocketUrl"];
  const normalizedUrl = isVibratoWebSocketUrl(candidateUrl)
    ? websocketUrl(candidateUrl)
    : defaultWebsocketUrl(mode);
  let normalizedAuth = DEFAULT_COMPARISON_CONFIG.auth;
  try {
    normalizedAuth = auth(input["auth"]);
  } catch {
    // Keep the no-credential default for malformed persisted auth.
  }
  const normalizedLanguage =
    typeof input["language"] === "string" && input["language"].trim()
      ? input["language"].trim()
      : DEFAULT_COMPARISON_LANGUAGE;
  let normalizedBrowserModuleUrl: string | undefined =
    DEFAULT_COMPARISON_CONFIG.browserWasmModuleUrl;
  try {
    normalizedBrowserModuleUrl =
      input["browserWasmModuleUrl"] === undefined
        ? DEFAULT_COMPARISON_CONFIG.browserWasmModuleUrl
        : browserWasmModuleUrl(input["browserWasmModuleUrl"]);
  } catch {
    // Ignore malformed optional browser WASM settings and use the global fallback.
  }
  let normalizedBrowserDictionaryUrl: string | undefined =
    DEFAULT_COMPARISON_CONFIG.browserWasmDictionaryUrl;
  try {
    normalizedBrowserDictionaryUrl =
      input["browserWasmDictionaryUrl"] === undefined
        ? DEFAULT_COMPARISON_CONFIG.browserWasmDictionaryUrl
        : browserWasmDictionaryUrl(input["browserWasmDictionaryUrl"]);
  } catch {
    // Ignore malformed optional browser dictionary settings and use the bundled default.
  }
  let normalizedBrowserGlobalName: string | undefined;
  try {
    normalizedBrowserGlobalName = optionalTrimmedString(
      input["browserWasmGlobalName"],
      "browserWasmGlobalName",
    );
  } catch {
    // Ignore malformed optional browser WASM settings and use the default global name.
  }
  return {
    schemaVersion: COMPARISON_CONFIG_SCHEMA_VERSION,
    mode,
    converterModel,
    websocketUrl: normalizedUrl,
    auth: normalizedAuth,
    language: normalizedLanguage,
    ...(normalizedBrowserModuleUrl ? { browserWasmModuleUrl: normalizedBrowserModuleUrl } : {}),
    ...(normalizedBrowserDictionaryUrl
      ? { browserWasmDictionaryUrl: normalizedBrowserDictionaryUrl }
      : {}),
    ...(normalizedBrowserGlobalName ? { browserWasmGlobalName: normalizedBrowserGlobalName } : {}),
  };
};

/** Parse unknown/local-storage data, falling back to the normalized defaults. */
export const parseComparisonConfig = (value: unknown): ComparisonConfig => {
  if (typeof value === "string") {
    try {
      return mergeComparisonConfig(JSON.parse(value) as unknown);
    } catch {
      return { ...DEFAULT_COMPARISON_CONFIG, auth: { ...DEFAULT_COMPARISON_CONFIG.auth } };
    }
  }
  return mergeComparisonConfig(value);
};

export type VibratoWebSocketUrlInput = Pick<ComparisonConfig, "websocketUrl"> | string;
export type VibratoWebSocketQuery = Record<string, string | number | boolean | undefined>;

const SENSITIVE_QUERY_KEY = /(?:token|secret|password|authorization|api[-_]?key)/i;

/**
 * Build a validated endpoint URL and append explicit, non-secret query values.
 * Authentication is intentionally not inferred from the config so a token
 * cannot accidentally end up in browser history, proxy logs, or telemetry.
 */
export const buildVibratoWebSocketUrl = (
  input: VibratoWebSocketUrlInput,
  query: VibratoWebSocketQuery = {},
): string => {
  const raw = typeof input === "string" ? input : input.websocketUrl;
  const normalized = websocketUrl(raw, "websocketUrl");
  const parsed = new URL(normalized);
  for (const [key, value] of Object.entries(query)) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      parsed.searchParams.set(key, value.trim());
    } else if (typeof value === "number" || typeof value === "boolean") {
      parsed.searchParams.set(key, String(value));
    }
  }
  return serializeWebSocketUrl(parsed);
};
