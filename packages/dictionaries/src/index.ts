/**
 * Shared dictionary locators matching Tauri `dictionary_resolve.rs`.
 *
 * Desktop is the source of truth for AzooKey kind names and config keys.
 * Worker and browser reuse these definitions so HTTPS/asset dictionaries are
 * classified the same way, then warmed at the runtime-specific moment that
 * corresponds to desktop capture start (before the first utterance).
 */

/** Desktop `models.paths` keys that may be a filesystem path or an HTTPS URL. */
export const AZOOKEY_DICTIONARY_CONFIG_KEYS = {
  system: "azookey-rust",
  user: "azookey-user-dictionary",
  learning: "azookey-learning-memory",
} as const;

export const AZOOKEY_DICTIONARY_CONFIG_KEY_LIST = [
  AZOOKEY_DICTIONARY_CONFIG_KEYS.system,
  AZOOKEY_DICTIONARY_CONFIG_KEYS.user,
  AZOOKEY_DICTIONARY_CONFIG_KEYS.learning,
] as const;

export type AzooKeyDictionaryConfigKey = (typeof AZOOKEY_DICTIONARY_CONFIG_KEY_LIST)[number];

/** Desktop `DictionaryKind::as_str` values. */
export const AZOOKEY_DICTIONARY_KIND = {
  system: "system",
  user: "user",
  learning: "learning-memory",
} as const;

export type AzooKeyDictionaryKind =
  (typeof AZOOKEY_DICTIONARY_KIND)[keyof typeof AZOOKEY_DICTIONARY_KIND];

export const VIBRATO_IPADIC_KIND = "vibrato-ipadic" as const;
export type VibratoDictionaryKind = typeof VIBRATO_IPADIC_KIND;

export type DictionaryKind = AzooKeyDictionaryKind | VibratoDictionaryKind;

/** Worker-hosted official AzooKey portable archive (AZKDIC01 gzip). */
export const DEFAULT_AZOOKEY_SYSTEM_ASSET_PATH = "/azookey/system.azkdict.gz";
/** Browser/Worker-hosted Vibrato IPADIC `system.dic.zst`. */
export const DEFAULT_VIBRATO_IPADIC_ASSET_PATH = "/vibrato/system.dic.zst";

/** IPADIC reading field (`feature[7]`); UniDic CWJ uses 20 instead. */
export const VIBRATO_IPADIC_FEATURE_INDEX = 7;

/**
 * When each runtime must finish dictionary I/O so the first caption is not
 * blocked on LOUDS/IPADIC initialization. Desktop capture start is canonical.
 */
export const DICTIONARY_WARM_MOMENT = {
  desktopCaptureStart: "capture-start",
  workerWebSocketUpgrade: "websocket-upgrade",
  browserConnectOrListen: "connect-or-listen-start",
} as const;

export type DictionaryWarmMoment =
  (typeof DICTIONARY_WARM_MOMENT)[keyof typeof DICTIONARY_WARM_MOMENT];

export const DICTIONARY_RUNTIME = {
  desktop: "desktop",
  worker: "worker",
  browser: "browser",
} as const;

export type DictionaryRuntime = (typeof DICTIONARY_RUNTIME)[keyof typeof DICTIONARY_RUNTIME];

/** A dictionary cold load is intentionally bounded separately from conversion. */
export const AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS = 10_000;
export const AZOOKEY_MIN_DICTIONARY_TIMEOUT_MS = 1_000;
export const AZOOKEY_MAX_DICTIONARY_TIMEOUT_MS = 60_000;
/** Desktop HTTPS download timeout (`dictionary_resolve::DOWNLOAD_TIMEOUT`). */
export const DESKTOP_DICTIONARY_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Worker isolate: refuse unexpectedly large remote Vibrato dictionaries. */
export const VIBRATO_MAX_DICTIONARY_BYTES = 12 * 1024 * 1024;
/** Browser/desktop headroom matching Tauri `MAX_DOWNLOAD_BYTES`. */
export const VIBRATO_BROWSER_MAX_DICTIONARY_BYTES = 64 * 1024 * 1024;
/** Compressed official AzooKey archive limit (pinned asset is about 10 MiB). */
export const AZOOKEY_MAX_COMPRESSED_DICTIONARY_BYTES = 16 * 1024 * 1024;
/** Uncompressed LOUDS/MM/CID archive limit before copying it into Wasm. */
export const AZOOKEY_MAX_DICTIONARY_BYTES = 32 * 1024 * 1024;
/** Desktop HTTPS dictionary download cap. */
export const DESKTOP_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export const dictionaryKindFromConfigKey = (key: string): AzooKeyDictionaryKind | undefined => {
  switch (key.trim()) {
    case AZOOKEY_DICTIONARY_CONFIG_KEYS.system:
      return AZOOKEY_DICTIONARY_KIND.system;
    case AZOOKEY_DICTIONARY_CONFIG_KEYS.user:
      return AZOOKEY_DICTIONARY_KIND.user;
    case AZOOKEY_DICTIONARY_CONFIG_KEYS.learning:
      return AZOOKEY_DICTIONARY_KIND.learning;
    default:
      return undefined;
  }
};

export const configKeyForDictionaryKind = (
  kind: AzooKeyDictionaryKind,
): AzooKeyDictionaryConfigKey => {
  switch (kind) {
    case AZOOKEY_DICTIONARY_KIND.system:
      return AZOOKEY_DICTIONARY_CONFIG_KEYS.system;
    case AZOOKEY_DICTIONARY_KIND.user:
      return AZOOKEY_DICTIONARY_CONFIG_KEYS.user;
    case AZOOKEY_DICTIONARY_KIND.learning:
      return AZOOKEY_DICTIONARY_CONFIG_KEYS.learning;
  }
};

/** Sibling key written with the local cache path while Settings keeps the URL. */
export const resolvedPathKey = (configuredKey: string): string =>
  `${configuredKey.trim()}-resolved`;

export type DictionaryLocator =
  | { type: "https"; href: string }
  | { type: "http"; href: string }
  | { type: "absolute-path"; path: string }
  | { type: "relative"; path: string }
  | {
      type: "invalid";
      reason: "empty" | "javascript-url" | "malformed-url" | "unsupported-scheme";
    };

export const classifyDictionaryLocator = (value: string): DictionaryLocator => {
  const trimmed = value.trim();
  if (!trimmed) {
    return { type: "invalid", reason: "empty" };
  }
  if (/^javascript:/iu.test(trimmed)) {
    return { type: "invalid", reason: "javascript-url" };
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://")) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "https:") {
        return { type: "https", href: trimmed };
      }
      if (parsed.protocol === "http:") {
        return { type: "http", href: trimmed };
      }
      return { type: "invalid", reason: "unsupported-scheme" };
    } catch {
      return { type: "invalid", reason: "malformed-url" };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return { type: "invalid", reason: "unsupported-scheme" };
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return { type: "absolute-path", path: trimmed };
  }
  return { type: "relative", path: trimmed };
};

export const isHttpsDictionaryUrl = (value: string): boolean =>
  classifyDictionaryLocator(value).type === "https";

export const isNonTlsHttpDictionaryUrl = (value: string): boolean =>
  classifyDictionaryLocator(value).type === "http";

/**
 * Locator allowed for a runtime.
 *
 * Desktop: HTTPS or filesystem (absolute/relative); plain HTTP is rejected.
 * Worker: HTTPS, HTTP, or `/asset` paths (Wrangler `ASSETS`).
 * Browser: HTTPS, HTTP, `/asset`, or relative URLs.
 */
export const isAllowedDictionaryLocator = (value: string, runtime: DictionaryRuntime): boolean => {
  const locator = classifyDictionaryLocator(value);
  switch (locator.type) {
    case "https":
      return true;
    case "http":
      return runtime === "worker" || runtime === "browser";
    case "absolute-path":
      return true;
    case "relative":
      return runtime === "desktop" || runtime === "browser";
    default:
      return false;
  }
};

export const clampDictionaryTimeoutMs = (value: string | undefined): number => {
  if (!value?.trim()) {
    return AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return AZOOKEY_DEFAULT_DICTIONARY_TIMEOUT_MS;
  }
  return Math.min(
    AZOOKEY_MAX_DICTIONARY_TIMEOUT_MS,
    Math.max(AZOOKEY_MIN_DICTIONARY_TIMEOUT_MS, Math.round(parsed)),
  );
};
