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
  ModelCatalog,
  RuntimeStatus,
  UnlistenFn,
} from "./types";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;

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

  listenConfig(callback: (config: AppConfig) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<AppConfig>("config:update", (event) => callback(event.payload));
    }
    return Promise.resolve(() => undefined);
  },

  listenRuntime(callback: (status: RuntimeStatus) => void): Promise<UnlistenFn> {
    if (isTauriRuntime()) {
      return listen<RuntimeStatus>("runtime:status", (event) => callback(event.payload));
    }
    return Promise.resolve(() => undefined);
  },
};
