import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import {
  ensureMicrophoneAccess,
  enumerateAudioInputDevices,
  formatAudioCaptureDiagnostics,
  getLastAudioCaptureDiagnostics,
  MicrophoneCapture,
} from "../core/audio";
import { bridge, formatBridgeError, isNoSpeechBridgeError } from "../core/bridge";
import { mergeCaptionPayload } from "../core/caption-updates";
import {
  clearChunkTimingStats,
  createLatestWinsProcessor,
  type LatestWinsProcessor,
  setChunkTimingStats,
} from "../core/chunkQueue";
import {
  createDefaultConfig,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_RUNTIME_STATUS,
} from "../core/defaults";
import { pushDiagnosticEvent } from "../core/diagnostics";
import {
  isTransientAudioNotice,
  type Notice,
  noticeForNoSpeech,
  noticeFromError,
  shouldToastAudioProcessingFailure,
} from "../core/notices";
import { pushPipelineStageEvent } from "../core/pipelineStages";
import type {
  AppConfig,
  AudioChunk,
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
  /** Latest-wins ASR queue: 1 in-flight + 1 pending (drop older pending). */
  const chunkProcessor = useRef<LatestWinsProcessor<AudioChunk> | null>(null);

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
        // Progressive TTFS: only the source-stage emit of the in-flight chunk.
        // Do not mark on late translation events (they can arrive while a newer
        // ASR job is already running and would skew first-caption timing).
        const isSourceStage =
          nextCaption.stage === "source" || (nextCaption.sequence === 0 && !nextCaption.isFinal);
        if (isSourceStage && nextCaption.sourceText.trim()) {
          chunkProcessor.current?.markFirstCaption();
          if (chunkProcessor.current) {
            setChunkTimingStats(chunkProcessor.current.getStats());
          }
        }
        setCaption((current) => {
          const merged = mergeCaptionPayload(current, nextCaption);
          if (merged === null) {
            return current;
          }
          return merged;
        });
        const stage =
          nextCaption.stage ?? (nextCaption.translationText.trim() ? "translation" : "source");
        // Log new utterances and translation completions (not every identical source paint).
        if (nextCaption.id !== lastCaptionId || stage === "translation") {
          lastCaptionId = nextCaption.id;
          const stats = chunkProcessor.current?.getStats();
          const latency =
            stats?.lastFirstCaptionMs != null ? ` · first=${stats.lastFirstCaptionMs}ms` : "";
          pushDiagnosticEvent(
            "caption",
            stage === "translation" ? "Caption translated" : "Caption source ready",
            `${nextCaption.id} · src=${nextCaption.sourceText.slice(0, 48)}${latency}`,
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
    // Fine-grained ASR / normalize / translate events for Debug mode.
    // Keep the subscription app-wide so the panel can stay open for continuous inspection.
    void bridge
      .listenPipelineStages((stageEvent) => {
        pushPipelineStageEvent(stageEvent);
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
          pushDiagnosticEvent(
            "error",
            "Pipeline stage listen failed",
            formatBridgeError(error) ?? String(error),
          );
        }
      });
    void bridge
      .listenRuntime((nextStatus) => {
        // Ambient / no-speech chunks must never pin a fatal lastError in the UI.
        // Keep the detail in the debug event log only.
        if (nextStatus.lastError && isNoSpeechBridgeError(nextStatus.lastError)) {
          pushDiagnosticEvent("audio", "No speech (soft-skip)", nextStatus.lastError);
          setStatus({ ...nextStatus, lastError: null });
          return;
        }
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
    // Quick-start may rewrite backend model selection (missing translator → minimal pack).
    void bridge
      .listenConfig((nextConfig) => {
        if (mounted) {
          setConfig(nextConfig);
          pushDiagnosticEvent(
            "config",
            "Config updated",
            `translator=${nextConfig.models.translator}`,
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
          pushDiagnosticEvent("error", "Config listen failed", notice.detail ?? notice.key);
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
    // Kick AudioContext construction / resume while the click gesture is still
    // warm. bridge.startCapture() may wait many seconds for sidecars; doing
    // resume() only after that wait leaves WKWebView contexts suspended.
    microphone.primeAudioContext();
    try {
      // Free the previous mic device before opening a new stream (NotReadableError
      // if two sessions pin the same input).
      await previousMicrophone.stop();
      if (attempt !== captureAttempt.current) {
        await microphone.stop().catch(() => undefined);
        return;
      }
      await bridge.stopCapture().catch(() => undefined);
      if (attempt !== captureAttempt.current) {
        await microphone.stop().catch(() => undefined);
        return;
      }

      // Overlap mic open with backend readiness so the first chunk is not rejected
      // for a cold gateway, without delaying getUserMedia past the user gesture.
      const preparePromise = microphone.prepareInput(captureConfig.audio.inputDeviceId);
      const backendPromise = bridge.startCapture();
      const [prepareResult, backendResult] = await Promise.allSettled([
        preparePromise,
        backendPromise,
      ]);
      if (attempt !== captureAttempt.current) {
        await Promise.allSettled([microphone.stop(), bridge.stopCapture()]);
        return;
      }
      if (backendResult.status === "rejected") {
        await microphone.stop().catch(() => undefined);
        throw backendResult.reason;
      }
      if (prepareResult.status === "rejected") {
        await bridge.stopCapture().catch(() => undefined);
        throw prepareResult.reason;
      }

      // Bound backlog: at most 1 ASR in-flight + 1 newest pending chunk.
      // Progressive backend already returns after ASR; this still prevents
      // serial queues of slow recognition from delaying live captions.
      chunkProcessor.current?.reset();
      clearChunkTimingStats();
      const processor = createLatestWinsProcessor<AudioChunk>({
        isActive: () => attempt === captureAttempt.current,
        onStatsChange: (stats) => {
          setChunkTimingStats(stats);
        },
        process: async (chunk) => {
          try {
            const nextCaption = await bridge.transcribeAudioChunk(chunk);
            if (attempt !== captureAttempt.current) {
              return;
            }
            // Soft-skip silence / no-speech chunks (empty sourceText) so ambient
            // noise that passes the RMS gate does not clear the live caption.
            if (!nextCaption.sourceText.trim()) {
              const detail =
                formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics()) || nextCaption.id;
              pushDiagnosticEvent("audio", "No speech (soft-skip)", detail);
              setStatus((current) =>
                current.lastError ? { ...current, lastError: null } : current,
              );
              // Non-fatal guidance — never "音声処理に失敗しました".
              setNotice(noticeForNoSpeech(detail));
              return;
            }
            // Caption events usually arrive first (progressive emit); still merge
            // the invoke result for browser-preview and event-loss fallbacks.
            setCaption((current) => {
              const merged = mergeCaptionPayload(current, nextCaption);
              if (merged === null) {
                return current;
              }
              return merged;
            });
            setStatus((current) => (current.lastError ? { ...current, lastError: null } : current));
            setNotice((current) => (isTransientAudioNotice(current) ? null : current));
          } catch (error: unknown) {
            if (attempt !== captureAttempt.current) {
              return;
            }
            // Defense in depth: if transcript_missing still arrives as Err
            // (older backend, gateway shape drift), soft-skip instead of toasting.
            if (!shouldToastAudioProcessingFailure(error)) {
              const detail =
                formatBridgeError(error) ??
                formatAudioCaptureDiagnostics(getLastAudioCaptureDiagnostics());
              pushDiagnosticEvent("audio", "No speech (soft-skip)", detail || undefined);
              setStatus((current) =>
                current.lastError ? { ...current, lastError: null } : current,
              );
              setNotice(noticeForNoSpeech(detail || undefined));
              return;
            }
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
        },
      });
      chunkProcessor.current = processor;

      await microphone.start(
        captureConfig.audio.inputDeviceId,
        captureConfig.audio.chunkMs,
        captureConfig.audio.silenceGateDb,
        (chunk) => {
          processor.enqueue(chunk);
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
    chunkProcessor.current?.reset();
    chunkProcessor.current = null;
    clearChunkTimingStats();
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
    : status.lastError && !isNoSpeechBridgeError(status.lastError)
      ? status.lastError
      : null;

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
