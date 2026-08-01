/**
 * Configuration shared by the comparison UI and the Vibrato WebSocket client.
 *
 * This contract deliberately lives under the comparison app instead of the
 * desktop app's `AppConfig`.  The desktop app has a different pipeline and
 * adding these fields there would make persisted desktop settings ambiguous.
 */

export const COMPARISON_CONFIG_SCHEMA_VERSION = 1 as const;

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
  websocketUrl: string;
  auth: ComparisonAuth;
  /** BCP-47 language tag sent in the Vibrato session.start payload. */
  language: string;
  /** Optional browser-side WASM module specifier; empty means use the global fallback. */
  browserWasmModuleUrl?: string;
  /** Optional global converter name used by browser-vibrato when no module URL is set. */
  browserWasmGlobalName?: string;
}

export type ComparisonConfigInput = {
  schemaVersion?: unknown;
  mode?: unknown;
  websocketUrl?: unknown;
  auth?: unknown;
  language?: unknown;
  browserWasmModuleUrl?: unknown;
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
    label: "Worker側",
    description: "Worker側で Vibrato → AzooKey を連続処理します。",
  },
  {
    value: "browser-vibrato",
    label: "ブラウザWASM → Worker",
    description: "ブラウザWASMで Vibrato を先に実行し、結果を Worker に渡します。",
  },
] as const;

/** Uppercase alias for callers that keep constants alongside desktop config names. */
export const COMPARISON_MODE_OPTIONS = comparisonModeOptions;

/** Short, user-facing explanations for the fields in the settings panel. */
export const comparisonConfigFieldDescriptions = {
  mode: "Choose whether Vibrato runs on the Worker or in browser WASM before the Worker.",
  websocketUrl: "A ws:// or wss:// URL for the selected Vibrato endpoint.",
  auth: "Optional Bearer credentials for the Worker. Keep tokens out of URLs and logs.",
  language: "BCP-47 language tag sent to the recognizer (for example, ja or en-US).",
  browserWasmModuleUrl:
    "Optional browser WASM module URL. Leave empty to use the named global converter fallback.",
  browserWasmGlobalName:
    "Optional global converter name for browser-vibrato (defaults to the built-in global name).",
} as const;

/** JSON Schema for persisted/transported comparison configuration. */
export const comparisonConfigSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AzooKey comparison configuration",
  type: "object",
  additionalProperties: false,
  required: ["mode", "websocketUrl", "auth", "language"],
  properties: {
    schemaVersion: { type: "integer", const: COMPARISON_CONFIG_SCHEMA_VERSION },
    mode: { type: "string", enum: [...COMPARISON_MODES] },
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
    browserWasmGlobalName: { type: "string", minLength: 1 },
  },
} as const;

export const DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL = "wss://vibrato-worker.example.invalid/ws";
const DEFAULT_BROWSER_VIBRATO_HOST = "127.0.0.1";
const DEFAULT_BROWSER_VIBRATO_PORT = 18_082;
const DEFAULT_BROWSER_VIBRATO_PATH = "/ws/recognition";
export const DEFAULT_BROWSER_VIBRATO_WEBSOCKET_URL = `ws://${DEFAULT_BROWSER_VIBRATO_HOST}:${DEFAULT_BROWSER_VIBRATO_PORT}${DEFAULT_BROWSER_VIBRATO_PATH}`;
export const DEFAULT_COMPARISON_LANGUAGE = "ja";
export const DEFAULT_COMPARISON_MODE: ComparisonMode = "worker-vibrato";

/** Worker is the comparison app's primary path; browser mode remains one select away. */
export const DEFAULT_COMPARISON_CONFIG: ComparisonConfig = {
  schemaVersion: COMPARISON_CONFIG_SCHEMA_VERSION,
  mode: DEFAULT_COMPARISON_MODE,
  websocketUrl: DEFAULT_WORKER_VIBRATO_WEBSOCKET_URL,
  auth: { scheme: "none" },
  language: DEFAULT_COMPARISON_LANGUAGE,
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
  const browserModuleUrl = browserWasmModuleUrl(value["browserWasmModuleUrl"]);
  const browserGlobalName = optionalTrimmedString(
    value["browserWasmGlobalName"],
    "browserWasmGlobalName",
  );
  return {
    schemaVersion: schemaVersion(value["schemaVersion"]),
    mode,
    websocketUrl: websocketUrl(value["websocketUrl"]),
    auth: auth(value["auth"]),
    language: language(value["language"]),
    ...(browserModuleUrl ? { browserWasmModuleUrl: browserModuleUrl } : {}),
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
  let normalizedBrowserModuleUrl: string | undefined;
  try {
    normalizedBrowserModuleUrl = browserWasmModuleUrl(input["browserWasmModuleUrl"]);
  } catch {
    // Ignore malformed optional browser WASM settings and use the global fallback.
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
    websocketUrl: normalizedUrl,
    auth: normalizedAuth,
    language: normalizedLanguage,
    ...(normalizedBrowserModuleUrl ? { browserWasmModuleUrl: normalizedBrowserModuleUrl } : {}),
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
