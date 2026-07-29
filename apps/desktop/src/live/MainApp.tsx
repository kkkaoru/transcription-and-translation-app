import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { AudioCaptureError, enumerateAudioInputDevices, MicrophoneCapture } from "../core/audio";
import { bridge } from "../core/bridge";
import {
  createDefaultConfig,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_RUNTIME_STATUS,
} from "../core/defaults";
import type {
  AppConfig,
  AudioInputDevice,
  CaptionPayload,
  ModelCatalog,
  ModelFamily,
  RuntimeStatus,
} from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import { createPreviewCaption } from "../overlay/captions";
import { SettingsView } from "../settings/SettingsView";
import { LiveView } from "./LiveView";

type ActiveTab = "live" | "settings";
type Notice = { detail?: string; key: MessageKey };

const platformKeys: Record<RuntimeStatus["platform"], MessageKey> = {
  macos: "platform.macos",
  windows: "platform.windows",
  linux: "platform.linux",
  unknown: "platform.unknown",
};

const statusKeys: Record<RuntimeStatus["status"], MessageKey> = {
  idle: "status.idle",
  starting: "status.starting",
  capturing: "status.capturing",
  error: "status.error",
};

const noticeFromError = (error: unknown, fallback: MessageKey): Notice => {
  if (error instanceof AudioCaptureError) {
    return {
      key:
        error.code === "microphone-unavailable"
          ? "message.microphoneUnavailable"
          : "message.audioContextFailed",
    };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    const keys: Partial<Record<string, MessageKey>> = {
      NotAllowedError: "message.microphonePermissionDenied",
      NotFoundError: "message.microphoneNotFound",
      NotReadableError: "message.microphoneBusy",
      OverconstrainedError: "message.microphoneConstraint",
    };
    const key = keys[error.name];
    return key ? { key } : { key: fallback, detail: error.message };
  }
  return error instanceof Error && error.message
    ? { key: fallback, detail: error.message }
    : { key: fallback };
};

export const MainApp = () => {
  const { t } = useI18n();
  const [config, setConfig] = useState<AppConfig>(createDefaultConfig);
  const [models, setModels] = useState<ModelCatalog>(DEFAULT_MODEL_CATALOG);
  const [status, setStatus] = useState<RuntimeStatus>(DEFAULT_RUNTIME_STATUS);
  const [caption, setCaption] = useState<CaptionPayload>(createPreviewCaption);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>("live");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const capture = useRef(new MicrophoneCapture());
  const captureAttempt = useRef(0);
  const chunkQueue = useRef(Promise.resolve());

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await enumerateAudioInputDevices());
    } catch (error) {
      setNotice(noticeFromError(error, "message.devicesFailed"));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void Promise.all([bridge.getConfig(), bridge.getModels(), bridge.getStatus()])
      .then(([nextConfig, nextModels, nextStatus]) => {
        if (!mounted) {
          return;
        }
        setConfig(nextConfig);
        setModels(nextModels);
        setStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (mounted) {
          setNotice(noticeFromError(error, "message.initializeFailed"));
        }
      });
    void refreshDevices();
    return () => {
      mounted = false;
      captureAttempt.current += 1;
      void capture.current.stop().catch(() => undefined);
    };
  }, [refreshDevices]);

  useEffect(() => {
    let mounted = true;
    const disposers: Array<() => void> = [];
    void bridge
      .listenCaptions(setCaption)
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          setNotice(noticeFromError(error, "message.initializeFailed"));
        }
      });
    void bridge
      .listenRuntime(setStatus)
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          setNotice(noticeFromError(error, "message.initializeFailed"));
        }
      });
    return () => {
      mounted = false;
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, []);

  const setModel = (family: ModelFamily, value: string) => {
    setConfig({ ...config, models: { ...config.models, [family]: value } });
  };

  const save = async () => {
    setSaving(true);
    try {
      await bridge.saveConfig(config);
      setNotice({ key: "message.saved" });
    } catch (error) {
      setNotice(noticeFromError(error, "message.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const startCapture = async (captureConfig: AppConfig) => {
    const attempt = ++captureAttempt.current;
    const microphone = new MicrophoneCapture();
    const previousMicrophone = capture.current;
    capture.current = microphone;
    setNotice(null);
    setStatus((current) => ({ ...current, status: "starting" }));
    try {
      await previousMicrophone.stop();
      if (attempt !== captureAttempt.current) {
        return;
      }
      await microphone.start(
        captureConfig.audio.inputDeviceId,
        captureConfig.audio.chunkMs,
        captureConfig.audio.silenceGateDb,
        (chunk) => {
          chunkQueue.current = chunkQueue.current
            .then(async () => {
              if (attempt !== captureAttempt.current) {
                return;
              }
              const nextCaption = await bridge.transcribeAudioChunk(chunk);
              if (attempt === captureAttempt.current) {
                setCaption(nextCaption);
              }
            })
            .catch((error: unknown) => {
              if (attempt === captureAttempt.current) {
                setNotice(noticeFromError(error, "message.audioProcessingFailed"));
              }
            });
        },
      );
      if (attempt !== captureAttempt.current) {
        await microphone.stop();
        return;
      }
      await bridge.startCapture();
      if (attempt !== captureAttempt.current) {
        await bridge.stopCapture();
        return;
      }
      await refreshDevices();
      if (attempt === captureAttempt.current) {
        setStatus((current) => ({ ...current, status: "capturing", lastError: null }));
      }
    } catch (error) {
      await Promise.allSettled([microphone.stop(), bridge.stopCapture()]);
      if (attempt !== captureAttempt.current) {
        return;
      }
      const nextNotice = noticeFromError(error, "message.microphoneStartFailed");
      setNotice(nextNotice);
      setStatus((current) => ({
        ...current,
        status: "error",
        lastError: nextNotice.detail ?? nextNotice.key,
      }));
    }
  };

  const stopCapture = async () => {
    captureAttempt.current += 1;
    const microphone = capture.current;
    capture.current = new MicrophoneCapture();
    const results = await Promise.allSettled([microphone.stop(), bridge.stopCapture()]);
    const failure = results.find((result) => result.status === "rejected");
    if (!failure) {
      setStatus((current) => ({ ...current, status: "idle", lastError: null }));
    } else {
      const nextNotice = noticeFromError(failure.reason, "message.microphoneStopFailed");
      setNotice(nextNotice);
      setStatus((current) => ({
        ...current,
        status: "error",
        lastError: nextNotice.detail ?? nextNotice.key,
      }));
    }
  };

  const openOverlay = async () => {
    try {
      await bridge.openOverlay();
    } catch (error) {
      setNotice(noticeFromError(error, "message.overlayOpenFailed"));
    }
  };

  const toggleCapture = () => {
    if (status.status === "capturing" || status.status === "starting") {
      void stopCapture();
    } else {
      void startCapture(config);
    }
  };

  const handleDeviceChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = {
      ...config,
      audio: { ...config.audio, inputDeviceId: event.target.value },
    };
    setConfig(next);
    if (status.status === "capturing") {
      void stopCapture().then(() => startCapture(next));
    }
  };

  const noticeText = notice
    ? [t(notice.key), notice.detail].filter((part) => part).join(" ")
    : null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <span>KB</span>
          </div>
          <div>
            <div className="brand-name">Kotoba Beacon</div>
            <div className="brand-caption">{t("brand.caption")}</div>
          </div>
        </div>
        <div className="topbar-meta">
          <LocaleSwitcher />
          <span className={`runtime-pill ${status.status}`}>
            <i />
            {t(statusKeys[status.status])}
          </span>
          <span className="platform-label">{t(platformKeys[status.platform])}</span>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-intro">
            <span className="eyebrow">{t("sidebar.eyebrow")}</span>
            <h1>{t("sidebar.title")}</h1>
            <p>{t("sidebar.description")}</p>
          </div>
          <nav className="nav-tabs" aria-label={t("sidebar.menu")}>
            <button
              className={activeTab === "live" ? "active" : ""}
              type="button"
              onClick={() => setActiveTab("live")}
            >
              <span className="nav-icon">◉</span> {t("sidebar.live")}
            </button>
            <button
              className={activeTab === "settings" ? "active" : ""}
              type="button"
              onClick={() => setActiveTab("settings")}
            >
              <span className="nav-icon">⌘</span> {t("sidebar.settings")}
            </button>
          </nav>
          <div className="sidebar-foot">
            <div className="privacy-note">
              <span className="privacy-icon">⌂</span>
              <span>
                <strong>{t("sidebar.privacyTitle")}</strong>
                <small>{t("sidebar.privacyDetail")}</small>
              </span>
            </div>
            <div className="version">
              MVP 0.1.0 <span>·</span> Tauri 2
            </div>
          </div>
        </aside>
        <main className="content">
          {activeTab === "live" ? (
            <LiveView
              config={config}
              status={status}
              caption={caption}
              devices={devices}
              message={noticeText}
              onToggleCapture={toggleCapture}
              onOpenOverlay={() => void openOverlay()}
              onDeviceChange={handleDeviceChange}
              onRefreshDevices={() => void refreshDevices()}
              onCloseMessage={() => setNotice(null)}
            />
          ) : (
            <SettingsView
              config={config}
              models={models}
              devices={devices}
              saving={saving}
              onConfigChange={setConfig}
              onModelChange={setModel}
              onDeviceChange={handleDeviceChange}
              onRefreshDevices={() => void refreshDevices()}
              onSave={() => void save()}
            />
          )}
        </main>
      </div>
    </div>
  );
};
