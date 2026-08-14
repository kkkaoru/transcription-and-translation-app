import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PartialAppConfig } from "./defaults";
import {
  createDefaultConfig,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_RUNTIME_STATUS,
  mergeConfig,
} from "./defaults";
import type { PipelineDropSignal } from "./dropDiagnostics";
import { normalizePipelineStageEvent } from "./pipelineStages";
import type {
  AppConfig,
  AudioChunk,
  CaptionPayload,
  CustomDictionaryEntry,
  DownloadProgress,
  ModelCatalog,
  ModelStatusEntry,
  ParapperRecognitionOutput,
  PartialWindowCaption,
  PipelineStageEvent,
  RelaunchResult,
  RuntimeDiagnostics,
  RuntimeStatus,
  UnlistenFn,
  UpdateMetadata,
  UpdateStatus,
} from "./types";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

/** Flatten nested Tauri/JSON rejection payloads into a single search string. */
const collectErrorText = (error: unknown, depth = 0): string => {
  if (depth > 4 || error == null) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }
  if (error instanceof Error) {
    return [error.name, error.message, collectErrorText(error.cause, depth + 1)]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["message", "error", "detail", "data", "body", "code"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        parts.push(value);
      } else if (value && typeof value === "object") {
        parts.push(collectErrorText(value, depth + 1));
      }
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "";
    }
  }
  return "";
};

/** Normalize Tauri / browser rejection values into a user-visible detail string. */
export const formatBridgeError = (error: unknown): string | undefined => {
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error", "detail", "data", "body"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === "object") {
        const nested = formatBridgeError(value);
        if (nested) {
          return nested;
        }
      }
    }
    // Last resort for opaque IPC envelopes (avoid stringifying bare numbers/bools).
    const collected = collectErrorText(error).trim();
    return collected || undefined;
  }
  return undefined;
};

const NO_SPEECH_HTTP_STATUSES = new Set([204, 404, 422]);

const statusFromValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
};

/** Find an HTTP status in a Tauri envelope or its human-readable message. */
const collectHttpStatus = (error: unknown, depth = 0): number | undefined => {
  if (depth > 4 || error == null) {
    return undefined;
  }
  if (typeof error === "string") {
    const match = error.match(
      /\bHTTP(?:\/\d(?:\.\d)?)?(?:\s+status)?\s*[: ]\s*(\d{3})\b|\b(?:status|status_code|http_status|httpStatus)\s*[:=]\s*["']?(\d{3})\b|["'](?:status|status_code|http_status|httpStatus)["']\s*:\s*["']?(\d{3})\b/i,
    );
    return statusFromValue(match?.[1] ?? match?.[2] ?? match?.[3]);
  }
  if (typeof error === "number") {
    return statusFromValue(error);
  }
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    for (const key of [
      "status",
      "statusCode",
      "status_code",
      "httpStatus",
      "http_status",
    ] as const) {
      const status = statusFromValue(record[key]);
      if (status !== undefined) {
        return status;
      }
    }
    return collectHttpStatus(error.message, depth + 1) ?? collectHttpStatus(error.cause, depth + 1);
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of [
      "status",
      "statusCode",
      "status_code",
      "httpStatus",
      "http_status",
    ] as const) {
      const status = statusFromValue(record[key]);
      if (status !== undefined) {
        return status;
      }
    }
    for (const key of ["message", "error", "detail", "data", "body", "cause"] as const) {
      const status = collectHttpStatus(record[key], depth + 1);
      if (status !== undefined) {
        return status;
      }
    }
  }
  return undefined;
};

const hasEmptyHttpBody = (error: unknown, depth = 0): boolean => {
  if (depth > 4 || error == null) {
    return false;
  }
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    return hasEmptyHttpBody(record["body"], depth + 1);
  }
  if (typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  if (Object.hasOwn(record, "body")) {
    const body = record["body"];
    return body == null || (typeof body === "string" && body.trim().length === 0);
  }
  for (const key of ["error", "data", "cause"] as const) {
    if (hasEmptyHttpBody(record[key], depth + 1)) {
      return true;
    }
  }
  return false;
};

const embeddedJson = (detail: string): Record<string, unknown> | null => {
  const direct = detail.trim();
  const candidates = [direct];
  const objectStart = direct.indexOf("{");
  if (objectStart > 0) {
    candidates.push(direct.slice(objectStart));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON transport text is handled by the bounded phrase checks below.
    }
  }
  return null;
};

const isNoSpeechPhrase = (detail: string): boolean => {
  const normalized = detail.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/(?:^|[\s:{,"'])transcript_missing(?:$|[\s},"'])/.test(normalized)) {
    return true;
  }
  const message =
    normalized.match(/\bhttp(?:\/\d(?:\.\d)?)?\s*[: ]\s*\d{3}\s*:\s*(.+)$/)?.[1] ?? normalized;
  return (
    /^(?:parapper )?completed without a final transcript$/.test(message) ||
    /^no final transcript$/.test(message) ||
    /^empty transcript$/.test(message) ||
    /^no transcript(?: available| returned| received)?$/.test(message) ||
    /^no usable speech$/.test(message) ||
    /^no(?:[- ]speech)$/.test(message) ||
    /\(no[- ]speech\)$/.test(message)
  );
};

const isNoSpeechDetail = (detail: string): boolean => {
  const parsed = embeddedJson(detail);
  if (parsed) {
    const errorValue = parsed["error"];
    const errorObject =
      errorValue && typeof errorValue === "object" && !Array.isArray(errorValue)
        ? (errorValue as Record<string, unknown>)
        : null;
    const code =
      typeof errorObject?.["code"] === "string" ? errorObject["code"].trim().toLowerCase() : "";
    if (code) {
      // An explicit non-silence gateway code wins over a coincidental empty
      // text field (for example invalid_audio + text: "").
      return code === "transcript_missing";
    }
    const hasTranscriptField = Object.hasOwn(parsed, "text") || Object.hasOwn(parsed, "transcript");
    if (hasTranscriptField) {
      const transcriptValue = Object.hasOwn(parsed, "text") ? parsed["text"] : parsed["transcript"];
      return (
        transcriptValue === null ||
        (typeof transcriptValue === "string" && transcriptValue.trim().length === 0)
      );
    }
    const message = typeof errorObject?.["message"] === "string" ? errorObject["message"] : "";
    if (message && isNoSpeechPhrase(message)) {
      return true;
    }
  }
  return isNoSpeechPhrase(detail);
};

/**
 * Parapper / gateway "no usable speech" outcomes that must never surface as
 * fatal audio-processing toasts during continuous capture.
 *
 * Matches both the structured gateway body (`transcript_missing`) and the
 * Rust pipeline error string (`inference returned HTTP 422: ...`).
 */
export const isNoSpeechBridgeError = (error: unknown): boolean => {
  const status = collectHttpStatus(error);
  // Match the native pipeline contract: only explicit empty/not-found/
  // transcript-missing responses are silence. In particular, a 5xx body may
  // mention transcript_missing while still representing a backend outage.
  if (status !== undefined && !NO_SPEECH_HTTP_STATUSES.has(status)) {
    return false;
  }
  // Prefer the user-facing message for Error instances (rather than the
  // synthetic `Error` class name prepended by collectErrorText), while keeping
  // collectErrorText as a fallback for opaque IPC envelopes.
  const detail = (formatBridgeError(error) ?? collectErrorText(error)).trim();
  // A standards-compliant 204 has no body and is itself the no-speech signal.
  const empty204Text =
    typeof error === "string" && /\bHTTP(?:\/\d(?:\.\d)?)?\s*[: ]\s*204\s*:?\s*$/i.test(error);
  if (status === 204 && (hasEmptyHttpBody(error) || empty204Text || !detail)) {
    return true;
  }
  return isNoSpeechDetail(detail);
};

const demoCaption = (): CaptionPayload => {
  const now = Date.now();
  return {
    id: `demo-${now}`,
    sourceText: "これはプレビュー用の字幕です。",
    translationText: "This is a preview caption.",
    sourceLanguage: "ja",
    targetLanguage: "en",
    startedAt: now,
    receivedAt: now,
  };
};

const browserStoreKey = "caption-bridge.config.v1";
const browserDictionaryStoreKey = "caption-bridge.custom-dictionary.v1";
const readBrowserConfig = (): AppConfig => {
  if (typeof localStorage === "undefined") {
    return createDefaultConfig();
  }
  try {
    const raw = localStorage.getItem(browserStoreKey);
    return raw ? mergeConfig(JSON.parse(raw) as PartialAppConfig) : createDefaultConfig();
  } catch {
    return createDefaultConfig();
  }
};

const readBrowserDictionary = (): CustomDictionaryEntry[] => {
  if (typeof localStorage === "undefined") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(browserDictionaryStoreKey) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is CustomDictionaryEntry =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as CustomDictionaryEntry).id === "string" &&
            typeof (entry as CustomDictionaryEntry).reading === "string" &&
            typeof (entry as CustomDictionaryEntry).word === "string",
        )
      : [];
  } catch {
    return [];
  }
};

let browserConfig = readBrowserConfig();
let browserDictionary = readBrowserDictionary();
let browserStatus = { ...DEFAULT_RUNTIME_STATUS, platform: "unknown" as const };

// Keep the most recent user-facing caption in the renderer as a second replay
// path. Native history is authoritative in the desktop runtime, but this
// cache also covers an event delivered just before a late subscriber mounts,
// and keeps browser/test doubles deterministic without requiring Tauri IPC.
let latestCaption: CaptionPayload | null = null;

const rememberCaption = (caption: CaptionPayload): void => {
  const stage = caption.stage;
  const sourceText = typeof caption.sourceText === "string" ? caption.sourceText : "";
  const translationText =
    typeof caption.translationText === "string" ? caption.translationText : "";
  if (
    (stage !== undefined && stage !== "source" && stage !== "translation") ||
    (!sourceText.trim() && !translationText.trim())
  ) {
    return;
  }
  latestCaption = caption;
};

/**
 * Build an identity for one caption:update payload.
 *
 * Native source publication is event-driven, while the corresponding invoke
 * resolves independently. A transport retry or an accidentally repeated
 * native emit can therefore deliver the exact same payload more than once.
 * Keep the bridge idempotent for identical events while still allowing any
 * actual revision (text, stage, timing, completion, etc.) through.
 */
const captionEventSignature = (caption: CaptionPayload): string =>
  JSON.stringify([
    caption.id,
    caption.sourceText,
    caption.azookeyInputText,
    caption.translationText,
    caption.sourceLanguage,
    caption.targetLanguage,
    caption.startedAt,
    caption.receivedAt,
    caption.stage,
    caption.sequence,
    caption.isFinal,
    caption.confidence,
    caption.provisional,
    caption.captureGeneration,
    caption.sentenceEndOffsets,
    caption.softBreakOffsets,
  ]);

const DEFAULT_UPDATE_STATUS: UpdateStatus = {
  status: "unsupported",
  currentVersion: null,
  availableVersion: null,
  checkedAt: null,
  downloadedBytes: null,
  totalBytes: null,
  error: null,
  source: null,
  channel: null,
  metadata: null,
};

export const bridge = {
  isDesktop: isTauriRuntime,

  getConfig(): Promise<AppConfig> {
    if (isTauriRuntime()) {
      return invoke<AppConfig>("get_config");
    }
    return Promise.resolve(browserConfig);
  },

  async saveConfig(config: AppConfig): Promise<void> {
    browserConfig = config;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(browserStoreKey, JSON.stringify(config));
    }
    if (isTauriRuntime()) {
      await invoke("save_config", { config });
    }
  },

  getCustomDictionary(): Promise<CustomDictionaryEntry[]> {
    if (isTauriRuntime()) {
      return invoke<CustomDictionaryEntry[]>("get_custom_dictionary");
    }
    return Promise.resolve(browserDictionary.map((entry) => ({ ...entry })));
  },

  saveCustomDictionary(entries: CustomDictionaryEntry[]): Promise<CustomDictionaryEntry[]> {
    if (isTauriRuntime()) {
      return invoke<CustomDictionaryEntry[]>("save_custom_dictionary", { entries });
    }
    browserDictionary = entries.map((entry) => ({ ...entry }));
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(browserDictionaryStoreKey, JSON.stringify(browserDictionary));
    }
    return Promise.resolve(browserDictionary.map((entry) => ({ ...entry })));
  },

  async reloadCustomDictionary(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("reload_custom_dictionary");
    }
  },

  async publishOverlayFrame(rgbaBase64: string, width: number, height: number): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("publish_overlay_frame", {
        frame: { rgbaBase64, width, height },
      });
    }
  },

  /**
   * Publish a source-only caption from a recognition mode that does not use
   * the native Parapper/AzooKey pipeline (Web Speech or raw Parapper).
   *
   * The native command records the same event for the overlay/replay path;
   * browser preview keeps the renderer-side cache so tests and the preview
   * remain deterministic without Tauri IPC.
   */
  async publishSourceCaption(caption: CaptionPayload): Promise<void> {
    const sourceText = caption.sourceText.trim();
    if (!sourceText) {
      return;
    }
    if (isTauriRuntime()) {
      await invoke("publish_source_caption", {
        caption: {
          id: caption.id,
          sourceText,
          sourceLanguage: caption.sourceLanguage,
          targetLanguage: caption.targetLanguage,
          startedAt: caption.startedAt,
          receivedAt: caption.receivedAt,
          isFinal: caption.isFinal,
          confidence: caption.confidence ?? null,
          // Without this the native command sees `None` and falls back to the
          // legacy active-status check, which cannot reject an invoke that a
          // Stop+Start superseded while it was in flight.
          captureGeneration: caption.captureGeneration ?? null,
        },
      });
      return;
    }
    rememberCaption({ ...caption, sourceText, translationText: "", stage: "source", sequence: 0 });
  },

  /** Forward a display-only OPEN-segment suffix to the independent Overlay webview. */
  async publishPartialWindow(caption: PartialWindowCaption): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("publish_partial_window_caption", { caption });
    }
  },

  getModels(): Promise<ModelCatalog> {
    if (isTauriRuntime()) {
      return invoke<ModelCatalog>("list_models");
    }
    return Promise.resolve(DEFAULT_MODEL_CATALOG);
  },

  getStatus(): Promise<RuntimeStatus> {
    if (isTauriRuntime()) {
      return invoke<RuntimeStatus>("get_runtime_status");
    }
    return Promise.resolve(browserStatus);
  },

  /**
   * Replay the latest normalized source/translation caption for late UI
   * consumers. Native history is best effort: older bundles, a disconnected
   * webview, or a command failure should not prevent the overlay from
   * mounting, so the last renderer-side event is returned as a fallback.
   */
  async getLatestCaption(): Promise<CaptionPayload | null> {
    if (isTauriRuntime()) {
      try {
        const caption = await invoke<CaptionPayload | null>("get_latest_caption");
        if (caption) {
          rememberCaption(caption);
          return caption;
        }
        // A successful native null means no native history is available. Keep
        // the renderer fallback for older bundles or an event that arrived
        // before native history was recorded; normal idle handling clears this
        // cache so it cannot resurrect a stopped-session caption.
      } catch {
        // Fall through to the renderer cache. Replay is intentionally
        // non-fatal when native history is unavailable.
      }
    }
    return latestCaption;
  },

  async startCapture(): Promise<number> {
    let captureGeneration = 0;
    if (isTauriRuntime()) {
      captureGeneration = await invoke<number>("start_capture");
    }
    browserStatus = { ...browserStatus, status: "capturing", lastError: null };
    return captureGeneration;
  },

  async stopCapture(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("stop_capture");
      latestCaption = null;
    } else {
      latestCaption = null;
    }
    browserStatus = { ...browserStatus, status: "idle" };
  },

  async transcribeAudioChunk(chunk: AudioChunk): Promise<CaptionPayload> {
    if (isTauriRuntime()) {
      return invoke<CaptionPayload>("transcribe_audio_chunk", { chunk });
    }
    await Promise.resolve();
    return demoCaption();
  },

  /** Normalize one structured output from the persistent Parapper session. */
  async normalizeParapperOutput(output: ParapperRecognitionOutput): Promise<CaptionPayload> {
    if (isTauriRuntime()) {
      return invoke<CaptionPayload>("normalize_parapper_output", { output });
    }
    await Promise.resolve();
    return demoCaption();
  },

  async openTransparentCapture(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("open_transparent_capture");
    }
  },

  async closeTransparentCapture(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("close_transparent_capture");
    }
  },

  /** Dedicated opaque style-editor window (not OBS transparent capture). */
  async openStyleEditorWindow(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("open_style_editor");
    }
  },

  /** Dedicated custom dictionary manager opened from Settings. */
  async openCustomDictionaryWindow(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("open_custom_dictionary");
    }
  },

  /**
   * Installed font family names from the OS (Tauri). Empty outside desktop or
   * when enumeration fails — callers merge with curated / Local Font Access.
   */
  async listSystemFonts(): Promise<string[]> {
    if (!isTauriRuntime()) {
      return [];
    }
    try {
      const fonts = await invoke<string[]>("list_system_fonts");
      return Array.isArray(fonts) ? fonts.filter((name) => typeof name === "string" && name) : [];
    } catch {
      return [];
    }
  },

  /** @deprecated Use openTransparentCapture — opens the Window Capture plate only. */
  async openOverlay(): Promise<void> {
    await this.openTransparentCapture();
  },

  /** @deprecated Use closeTransparentCapture — never stops Syphon/Spout publishing. */
  async closeOverlay(): Promise<void> {
    await this.closeTransparentCapture();
  },

  listenCaptions(callback: (caption: CaptionPayload) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      // Keep this state local to each listener. Two webviews (main + overlay)
      // must both receive the first event, while a duplicate payload delivered
      // to one listener should not trigger a second paint or diagnostic row.
      let lastSignature: string | null = null;
      return listen<CaptionPayload>("caption:update", (event) => {
        const signature = captionEventSignature(event.payload);
        if (signature === lastSignature) {
          return;
        }
        lastSignature = signature;
        rememberCaption(event.payload);
        callback(event.payload);
      });
    }
    return Promise.resolve(() => undefined);
  },

  /** Display-only partial window events never enter the normalized caption merge path. */
  listenPartialWindows(callback: (caption: PartialWindowCaption) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<PartialWindowCaption>("caption:partial-window", (event) =>
        callback(event.payload),
      );
    }
    return Promise.resolve(() => undefined);
  },

  /** Per-stage ASR / normalize / translate timings + text samples for debug mode. */
  listenPipelineStages(callback: (stage: PipelineStageEvent) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<PipelineStageEvent>("pipeline:stage", (event) => callback(event.payload));
    }
    return Promise.resolve(() => undefined);
  },

  /** Surface native queue drops in the same bounded diagnostics aggregate as renderer drops. */
  listenPipelineDrops(callback: (drop: PipelineDropSignal) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<PipelineDropSignal>("pipeline:drop", (event) => callback(event.payload));
    }
    return Promise.resolve(() => undefined);
  },

  listenConfig(callback: (config: AppConfig) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<AppConfig>("config:update", (event) => callback(event.payload));
    }
    return Promise.resolve(() => undefined);
  },

  getDebugInfo(): Promise<Record<string, unknown>> {
    if (isTauriRuntime()) {
      return invoke<Record<string, unknown>>("get_debug_info");
    }
    return Promise.resolve({
      platform: "browser",
      note: "Debug info is only available in the desktop app.",
    });
  },

  /**
   * Recover native pipeline rows that may have been emitted before the
   * app-wide `pipeline:stage` listener or Debug panel mounted.
   *
   * The native command exposes these rows as `pipelineStages` inside the
   * debug snapshot. Normalize through the same boundary used by live events
   * so callers can safely merge the result into the UI stage store.
   */
  async getPipelineStageHistory(): Promise<PipelineStageEvent[]> {
    const info = await this.getDebugInfo();
    const raw = info["pipelineStages"] ?? info["pipelineStageHistory"] ?? info["stageHistory"];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((entry) => normalizePipelineStageEvent(entry))
      .filter((entry): entry is PipelineStageEvent => entry !== null);
  },

  /** Return the last native updater snapshot without triggering network I/O. */
  getUpdateStatus(): Promise<UpdateStatus> {
    if (isTauriRuntime()) {
      return invoke<UpdateStatus>("get_update_status");
    }
    return Promise.resolve({ ...DEFAULT_UPDATE_STATUS });
  },

  /** Ask the native updater to check its configured feed. */
  checkForUpdate(): Promise<UpdateMetadata | null> {
    if (isTauriRuntime()) {
      return invoke<UpdateMetadata | null>("check_for_update");
    }
    return Promise.resolve(null);
  },

  /** Download and install the update selected by the last check. */
  installUpdate(): Promise<void> {
    if (isTauriRuntime()) {
      return invoke<void>("install_update");
    }
    return Promise.reject(new Error("Updates are only available in the desktop app."));
  },

  /** Request the native bundle switch after an update has been installed. */
  relaunchToUpdatedApp(): Promise<RelaunchResult> {
    if (isTauriRuntime()) {
      return invoke<RelaunchResult>("relaunch_to_updated_app");
    }
    return Promise.reject(new Error("Relaunch is only available in the desktop app."));
  },

  /** Convenience command used by support tooling and smoke tests. */
  checkAndInstallUpdate(): Promise<void> {
    if (isTauriRuntime()) {
      return invoke<void>("check_and_install_update");
    }
    return Promise.reject(new Error("Updates are only available in the desktop app."));
  },

  /** Runtime diagnostics are a typed view of the extra fields in get_debug_info. */
  async getRuntimeDiagnostics(): Promise<RuntimeDiagnostics | null> {
    const info = await this.getDebugInfo();
    const update = info["update"];
    const sidecars = info["sidecars"];
    if (!update && !sidecars) {
      return null;
    }
    return {
      update: (update as UpdateStatus | undefined) ?? { ...DEFAULT_UPDATE_STATUS },
      sidecars: Array.isArray(sidecars) ? (sidecars as RuntimeDiagnostics["sidecars"]) : [],
      updateHistory: Array.isArray(info["updateHistory"])
        ? (info["updateHistory"] as Array<Record<string, unknown>>)
        : undefined,
    };
  },

  /**
   * Write a structured log export into the native app log directory.
   * Browser preview falls back to a no-op path so callers can still download locally.
   */
  exportDebugLogs(body: string, format: "json" | "jsonl" = "jsonl"): Promise<string> {
    if (isTauriRuntime()) {
      return invoke<string>("export_debug_logs", { body, format });
    }
    return Promise.resolve(`browser-download-only.${format}`);
  },

  listenRuntime(callback: (status: RuntimeStatus) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<RuntimeStatus>("runtime:status", (event) => {
        if (event.payload.status === "idle" && !event.payload.lastError) {
          // Keep the renderer replay fallback in sync with the native slot.
          // This matters when an older bundle lacks get_latest_caption: an
          // idle event must not leave its pre-stop cache available for replay.
          latestCaption = null;
        }
        callback(event.payload);
      });
    }
    return Promise.resolve(() => undefined);
  },

  listenUpdateStatus(callback: (status: UpdateStatus) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<UpdateStatus>("update:status", (event) => callback(event.payload));
    }
    return Promise.resolve(() => undefined);
  },

  listenUpdateRelaunchDeferred(callback: (reason: string) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<string>("update:relaunch-deferred", (event) => callback(event.payload));
    }
    return Promise.resolve(() => undefined);
  },

  downloadModel(modelId: string): Promise<string> {
    if (!isTauriRuntime()) {
      return Promise.reject(new Error("Model download is only available in the desktop app."));
    }
    return invoke<string>("download_model", { modelId });
  },

  downloadQuickStart(): Promise<string[]> {
    if (!isTauriRuntime()) {
      return Promise.reject(new Error("Model download is only available in the desktop app."));
    }
    return invoke<string[]>("download_quick_start");
  },

  cancelModelDownload(modelId: string): Promise<void> {
    if (!isTauriRuntime()) {
      return Promise.reject(new Error("Model download is only available in the desktop app."));
    }
    return invoke<void>("cancel_model_download", { modelId });
  },

  /**
   * Download and extract the input-LM N-gram rescorer model (120 MB ZIP).
   * User-triggered only — never auto-downloaded. Emits `model:download:progress`
   * events on the same channel as GGUF downloads. Cancellable via
   * `cancelModelDownload("input-n5-lm-v1")`.
   */
  downloadInputLmModel(): Promise<string> {
    if (!isTauriRuntime()) {
      return Promise.reject(new Error("Model download is only available in the desktop app."));
    }
    return invoke<string>("download_input_lm_model");
  },

  listModelStatus(): Promise<ModelStatusEntry[]> {
    if (!isTauriRuntime()) {
      return Promise.resolve([]);
    }
    return invoke<ModelStatusEntry[]>("list_model_status");
  },

  listenDownloadProgress(callback: (progress: DownloadProgress) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<DownloadProgress>("model:download:progress", (event) =>
        callback(event.payload),
      );
    }
    return Promise.resolve(() => undefined);
  },
};
