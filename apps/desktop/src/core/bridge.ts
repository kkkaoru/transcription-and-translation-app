import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PartialAppConfig } from "./defaults";
import {
  createDefaultConfig,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_RUNTIME_STATUS,
  mergeConfig,
} from "./defaults";
import type {
  AppConfig,
  AudioChunk,
  CaptionPayload,
  DownloadProgress,
  ModelCatalog,
  ModelStatusEntry,
  PipelineStageEvent,
  RuntimeStatus,
  UnlistenFn,
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

/**
 * Parapper / gateway "no usable speech" outcomes that must never surface as
 * fatal audio-processing toasts during continuous capture.
 *
 * Matches both the structured gateway body (`transcript_missing`) and the
 * Rust pipeline error string (`inference returned HTTP 422: ...`).
 */
export const isNoSpeechBridgeError = (error: unknown): boolean => {
  const detail = collectErrorText(error).toLowerCase();
  if (!detail) {
    return false;
  }
  return (
    detail.includes("transcript_missing") ||
    detail.includes("without a final transcript") ||
    detail.includes("no final transcript") ||
    detail.includes("no transcript") ||
    detail.includes("empty transcript") ||
    // Soft empty success paths (defense if a wrapper rephrases).
    detail.includes("no speech") ||
    detail.includes("no usable speech")
  );
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

let browserConfig = readBrowserConfig();
let browserStatus = { ...DEFAULT_RUNTIME_STATUS, platform: "unknown" as const };

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

  async publishOverlayFrame(rgbaBase64: string, width: number, height: number): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("publish_overlay_frame", {
        frame: { rgbaBase64, width, height },
      });
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

  async startCapture(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("start_capture");
    }
    browserStatus = { ...browserStatus, status: "capturing", lastError: null };
  },

  async stopCapture(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("stop_capture");
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

  async openOverlay(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("open_overlay");
    }
  },

  async closeOverlay(): Promise<void> {
    if (isTauriRuntime()) {
      await invoke("close_overlay");
    }
  },

  listenCaptions(callback: (caption: CaptionPayload) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<CaptionPayload>("caption:update", (event) => callback(event.payload));
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

  listenRuntime(callback: (status: RuntimeStatus) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<RuntimeStatus>("runtime:status", (event) => callback(event.payload));
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
