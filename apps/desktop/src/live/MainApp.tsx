import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import {
  AudioCaptureError,
  ensureMicrophoneAccess,
  enumerateAudioInputDevices,
  formatAudioCaptureDiagnostics,
  getLastAudioCaptureDiagnostics,
  MicrophoneCapture,
} from "../core/audio";
import { bridge, formatBridgeError } from "../core/bridge";
import {
  createDefaultConfig,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_RUNTIME_STATUS,
} from "../core/defaults";
import { pushDiagnosticEvent } from "../core/diagnostics";
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
    const keys: Record<AudioCaptureError["code"], MessageKey> = {
      "microphone-unavailable": "message.microphoneUnavailable",
      "audio-context-failed": "message.audioContextFailed",
      "audio-context-suspended": "message.audioContextFailed",
      "microphone-track-ended": "message.microphoneTrackEnded",
    };
    const detail =
      error.causeError instanceof DOMException
        ? error.causeError.message
        : error.message !== error.code
          ? error.message
          : formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics()) || undefined;
    return { key: keys[error.code], detail: detail || undefined };
  }
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    const keys: Partial<Record<string, MessageKey>> = {
      NotAllowedError: "message.microphonePermissionDenied",
      SecurityError: "message.microphonePermissionDenied",
      NotFoundError: "message.microphoneNotFound",
      NotReadableError: "message.microphoneBusy",
      OverconstrainedError: "message.microphoneConstraint",
      AbortError: "message.microphoneStartFailed",
    };
    const key = keys[error.name];
    const diag = formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics());
    if (key) {
      return diag ? { key, detail: diag } : { key };
    }
    return {
      key: fallback,
      detail: [error.message, diag].filter(Boolean).join(" · ") || undefined,
    };
  }
  const detail = formatBridgeError(error);
  const diag = formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics());
  const combined = [detail, diag].filter(Boolean).join(" · ");
  return combined ? { key: fallback, detail: combined } : { key: fallback };
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
  const [inputLevelDb, setInputLevelDb] = useState<number | null>(null);
  const capture = useRef(new MicrophoneCapture());
  const captureAttempt = useRef(0);
  const chunkQueue = useRef(Promise.resolve());

  const refreshDevices = useCallback(async (options?: { primePermission?: boolean }) => {
    try {
      if (options?.primePermission) {
        try {
          const mode = await ensureMicrophoneAccess();
          pushDiagnosticEvent("audio", "Microphone permission primed", `mode=${mode}`);
        } catch (error) {
          // Still attempt enumeration; surface a permission-oriented notice if it fails.
          const notice = noticeFromError(error, "message.microphonePermissionDenied");
          pushDiagnosticEvent(
            "error",
            "Microphone permission probe failed",
            notice.detail ?? notice.key,
          );
          setNotice(notice);
        }
      }
      const next = await enumerateAudioInputDevices();
      setDevices(next);
      pushDiagnosticEvent("audio", "Device list refreshed", `${next.length} input(s)`);
    } catch (error) {
      const notice = noticeFromError(error, "message.devicesFailed");
      pushDiagnosticEvent("error", "Device enumeration failed", notice.detail ?? notice.key);
      setNotice(notice);
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
        pushDiagnosticEvent(
          "runtime",
          "App initialized",
          `status=${nextStatus.status} · platform=${nextStatus.platform}`,
        );
      })
      .catch((error: unknown) => {
        if (mounted) {
          const notice = noticeFromError(error, "message.initializeFailed");
          pushDiagnosticEvent("error", "Initialize failed", notice.detail ?? notice.key);
          setNotice(notice);
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
    let lastCaptionId: string | null = null;
    void bridge
      .listenCaptions((nextCaption) => {
        setCaption(nextCaption);
        // Avoid flooding the ring buffer with every partial/identical payload.
        if (nextCaption.id !== lastCaptionId) {
          lastCaptionId = nextCaption.id;
          pushDiagnosticEvent(
            "caption",
            "Caption update",
            `${nextCaption.id} · src=${nextCaption.sourceText.slice(0, 48)}`,
          );
        }
      })
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          const notice = noticeFromError(error, "message.initializeFailed");
          pushDiagnosticEvent("error", "Caption listen failed", notice.detail ?? notice.key);
          setNotice(notice);
        }
      });
    void bridge
      .listenRuntime((nextStatus) => {
        setStatus(nextStatus);
        pushDiagnosticEvent(
          "runtime",
          `Runtime → ${nextStatus.status}`,
          nextStatus.lastError ?? `backend=${String(nextStatus.backendReachable)}`,
        );
      })
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
      })
      .catch((error: unknown) => {
        if (mounted) {
          const notice = noticeFromError(error, "message.initializeFailed");
          pushDiagnosticEvent("error", "Runtime listen failed", notice.detail ?? notice.key);
          setNotice(notice);
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
      pushDiagnosticEvent("config", "Settings saved");
      setNotice({ key: "message.saved" });
    } catch (error) {
      const notice = noticeFromError(error, "message.saveFailed");
      pushDiagnosticEvent("error", "Save failed", notice.detail ?? notice.key);
      setNotice(notice);
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
    setInputLevelDb(null);
    setStatus((current) => ({ ...current, status: "starting", lastError: null }));
    pushDiagnosticEvent(
      "audio",
      "Capture starting",
      `device=${captureConfig.audio.inputDeviceId} · chunk=${captureConfig.audio.chunkMs}ms`,
    );
    try {
      // Stop any previous capture, then prepare backend (models / sidecars)
      // before opening the microphone so the first audio chunks are not rejected
      // while the translator or Parapper services are still starting.
      await previousMicrophone.stop();
      if (attempt !== captureAttempt.current) {
        return;
      }
      await bridge.stopCapture().catch(() => undefined);
      if (attempt !== captureAttempt.current) {
        return;
      }
      await bridge.startCapture();
      if (attempt !== captureAttempt.current) {
        await bridge.stopCapture().catch(() => undefined);
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
                setStatus((current) =>
                  current.lastError ? { ...current, lastError: null } : current,
                );
              }
            })
            .catch((error: unknown) => {
              if (attempt === captureAttempt.current) {
                const nextNotice = noticeFromError(error, "message.audioProcessingFailed");
                pushDiagnosticEvent(
                  "error",
                  "Audio processing failed",
                  nextNotice.detail ?? t(nextNotice.key),
                );
                setNotice(nextNotice);
                setStatus((current) => ({
                  ...current,
                  // Keep capturing so the Stop button remains available; only
                  // surface the last backend/transcription error.
                  lastError: nextNotice.detail ?? t(nextNotice.key),
                }));
              }
            });
        },
        (captureError) => {
          // Track ended / mid-session mic loss: stop cleanly and surface diagnostics.
          if (attempt !== captureAttempt.current) {
            return;
          }
          const nextNotice = noticeFromError(captureError, "message.microphoneStartFailed");
          pushDiagnosticEvent(
            "error",
            "Microphone track error",
            nextNotice.detail ?? nextNotice.key,
          );
          void stopCapture().then(() => {
            // stopCapture() increments captureAttempt by 1. Skip if the user already
            // started a newer session (attempt advanced by more than that).
            if (captureAttempt.current > attempt + 1) {
              return;
            }
            setNotice(nextNotice);
            setStatus((current) => ({
              ...current,
              status: "error",
              lastError: nextNotice.detail ?? t(nextNotice.key),
            }));
          });
        },
        (rmsDb) => {
          if (attempt === captureAttempt.current) {
            setInputLevelDb(rmsDb);
          }
        },
      );
      if (attempt !== captureAttempt.current) {
        await Promise.allSettled([microphone.stop(), bridge.stopCapture()]);
        return;
      }
      await refreshDevices();
      if (attempt === captureAttempt.current) {
        const diag = microphone.getDiagnostics();
        pushDiagnosticEvent(
          "audio",
          "Capture started",
          formatAudioCaptureDiagnostics(diag) || `mode=${diag.captureMode}`,
        );
        setStatus((current) => ({ ...current, status: "capturing", lastError: null }));
      }
    } catch (error) {
      await Promise.allSettled([microphone.stop(), bridge.stopCapture()]);
      if (attempt !== captureAttempt.current) {
        return;
      }
      // Prefer a backend-prep message when the mic never started; formatBridgeError
      // still carries the concrete Rust/sidecar detail. When the failure is a
      // browser mic error, noticeFromError maps DOMException names first.
      const nextNotice = noticeFromError(error, "message.captureStartFailed");
      pushDiagnosticEvent("error", "Capture start failed", nextNotice.detail ?? nextNotice.key);
      setNotice(nextNotice);
      setStatus((current) => ({
        ...current,
        status: "error",
        lastError: nextNotice.detail ?? t(nextNotice.key),
      }));
    }
  };

  const stopCapture = async () => {
    captureAttempt.current += 1;
    const microphone = capture.current;
    capture.current = new MicrophoneCapture();
    setInputLevelDb(null);
    pushDiagnosticEvent("audio", "Capture stopping");
    const results = await Promise.allSettled([microphone.stop(), bridge.stopCapture()]);
    const failure = results.find((result) => result.status === "rejected");
    if (!failure) {
      pushDiagnosticEvent("audio", "Capture stopped");
      setStatus((current) => ({ ...current, status: "idle", lastError: null }));
    } else {
      const nextNotice = noticeFromError(failure.reason, "message.microphoneStopFailed");
      pushDiagnosticEvent("error", "Capture stop failed", nextNotice.detail ?? nextNotice.key);
      setNotice(nextNotice);
      setStatus((current) => ({
        ...current,
        status: "error",
        lastError: nextNotice.detail ?? t(nextNotice.key),
      }));
    }
  };

  const openOverlay = async () => {
    try {
      await bridge.openOverlay();
      pushDiagnosticEvent(
        "overlay",
        "Overlay opened",
        `${config.overlay.width}×${config.overlay.height}`,
      );
    } catch (error) {
      const notice = noticeFromError(error, "message.overlayOpenFailed");
      pushDiagnosticEvent("error", "Overlay open failed", notice.detail ?? notice.key);
      setNotice(notice);
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
    : (status.lastError ?? null);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <img className="brand-mark-image" src="/app-icon.png" alt="" width={39} height={39} />
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
              inputLevelDb={inputLevelDb}
              onToggleCapture={toggleCapture}
              onOpenOverlay={() => void openOverlay()}
              onDeviceChange={handleDeviceChange}
              onRefreshDevices={() => void refreshDevices({ primePermission: true })}
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
              onRefreshDevices={() => void refreshDevices({ primePermission: true })}
              onSave={() => void save()}
            />
          )}
        </main>
      </div>
    </div>
  );
};
