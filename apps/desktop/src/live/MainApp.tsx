import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import {
  ensureMicrophoneAccess,
  enumerateAudioInputDevices,
  formatAudioCaptureDiagnostics,
  MicrophoneCapture,
} from "../core/audio";
import { bridge, formatBridgeError, isNoSpeechBridgeError } from "../core/bridge";
import { BUILD_INFO } from "../core/buildInfo";
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
import { clearCaptionDisplayTiming, markCaptionDisplay } from "../core/display-timing";
import { clearInputLevelDb, setInputLevelDb } from "../core/input-level";
import {
  isTransientAudioNotice,
  type Notice,
  noticeForNoSpeech,
  noticeFromError,
  shouldToastAudioProcessingFailure,
} from "../core/notices";
import {
  DEFAULT_PARAPPER_STREAM_URL,
  ParapperRecognitionStream,
  type ParapperStreamEvent,
} from "../core/parapperStream";
import { hydratePipelineStageEvents, pushPipelineStageEvent } from "../core/pipelineStages";
import type {
  AppConfig,
  AudioChunk,
  AudioInputDevice,
  CaptionPayload,
  ModelCatalog,
  ModelFamily,
  ParapperRecognitionOutput,
  RuntimeStatus,
} from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import { createEmptyCaption, createPreviewCaption } from "../overlay/captions";
import { DebugPanel } from "../settings/DebugPanel";
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
  const capture = useRef(new MicrophoneCapture());
  const captureAttempt = useRef(0);
  /** Latest-wins ASR queue: 1 in-flight + 1 pending (drop older pending). */
  const chunkProcessor = useRef<LatestWinsProcessor<AudioChunk> | null>(null);
  /** One continuous Parapper VAD/Segment/Turn session for desktop capture. */
  const parapperStream = useRef<ParapperRecognitionStream | null>(null);
  /** Preserve Parapper output order while native AzooKey normalizes revisions. */
  const parapperOutputChain = useRef<Promise<void>>(Promise.resolve());
  /** Avoid runtime:status re-renders when the backend re-emits an identical snapshot. */
  const lastRuntimeStatusKey = useRef<string>("");
  /** Ignore caption events that arrive after a stop/idle transition. */
  const captionIdleGuard = useRef(false);
  /** Preserve the last caption when processing reported a real failure. */
  const captionFailureMessage = useRef<string | null>(null);

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
        captionIdleGuard.current = nextStatus.status === "idle";
        captionFailureMessage.current =
          nextStatus.lastError && !isNoSpeechBridgeError(nextStatus.lastError)
            ? nextStatus.lastError
            : null;
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
    // A stage can finish before the listener is attached (for example while a
    // webview is being restored).  Seed the in-memory store from the native
    // debug snapshot as a best-effort supplement; the live event listener below
    // remains the source of truth for subsequent rows.
    void bridge
      .getDebugInfo()
      .then((info) => {
        if (!mounted || !info || typeof info !== "object") {
          return;
        }
        const record = info as Record<string, unknown>;
        const history = record["pipelineStages"] ?? record["stageHistory"];
        hydratePipelineStageEvents(history);
      })
      .catch(() => undefined);
    void refreshDevices();
    return () => {
      mounted = false;
      captureAttempt.current += 1;
      parapperStream.current?.cancel();
      parapperStream.current = null;
      void capture.current.stop().catch(() => undefined);
    };
  }, [refreshDevices]);

  useEffect(() => {
    let mounted = true;
    const disposers: Array<() => void> = [];
    let lastCaptionId: string | null = null;
    void bridge
      .listenCaptions((nextCaption) => {
        // A background translation can complete after Stop. Once the runtime
        // is idle, retain the last caption (on failure) or the explicit empty
        // state (on success) rather than repainting a stale event.
        if (captionIdleGuard.current) {
          return;
        }
        // TTFS: mark only when a normalized source-stage event actually paints.
        // Late events for an older utterance are dropped by merge and must not
        // release the queue / skew first-caption timing for a newer flight.
        const isSourceStage =
          nextCaption.stage === "source" || (nextCaption.sequence === 0 && !nextCaption.isFinal);
        let paintedProgressiveSource = false;
        setCaption((current) => {
          const merged = mergeCaptionPayload(current, nextCaption);
          if (merged === null || merged === current) {
            return current;
          }
          if (isSourceStage && merged.sourceText.trim()) {
            paintedProgressiveSource = true;
          }
          markCaptionDisplay(merged);
          return merged;
        });
        if (paintedProgressiveSource) {
          chunkProcessor.current?.markFirstCaption();
          if (chunkProcessor.current) {
            setChunkTimingStats(chunkProcessor.current.getStats());
          }
        }
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
            stage === "translation" ? "Caption translated" : "Caption normalized source ready",
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
        // Progressive first paint: raw ASR text is available well before the
        // normalizer finishes, and the backend never sends it over the
        // caption:update channel (it stays debug-only there). Paint it here,
        // client-side, as a low-emphasis provisional caption on the same
        // utterance id; mergeCaptionPayload upgrades it in place (same id, no
        // new caption entry) once the real normalized `source` caption
        // arrives below. This does not call markFirstCaption() / release the
        // chunkQueue — that release stays tied to the normalized source paint
        // so the existing no-head-of-line-blocking guarantee for translation
        // (and the next chunk's ASR call) is unchanged.
        if (
          !captionIdleGuard.current &&
          stageEvent.stage === "asr" &&
          stageEvent.ok &&
          stageEvent.outputText.trim()
        ) {
          setCaption((current) => {
            const provisional: CaptionPayload = {
              id: stageEvent.utteranceId,
              sourceText: stageEvent.outputText,
              translationText: "",
              sourceLanguage: current.sourceLanguage,
              targetLanguage: current.targetLanguage,
              startedAt: stageEvent.startedAt,
              receivedAt: stageEvent.at,
              stage: "source",
              sequence: 0,
              isFinal: false,
              provisional: true,
            };
            const merged = mergeCaptionPayload(current, provisional);
            if (merged === null || merged === current) {
              return current;
            }
            markCaptionDisplay(merged);
            return merged;
          });
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
        const sanitized =
          nextStatus.lastError && isNoSpeechBridgeError(nextStatus.lastError)
            ? { ...nextStatus, lastError: null }
            : nextStatus;
        if (nextStatus.lastError && isNoSpeechBridgeError(nextStatus.lastError)) {
          pushDiagnosticEvent("audio", "No speech (soft-skip)", nextStatus.lastError);
        }
        captionIdleGuard.current = sanitized.status === "idle";
        if (sanitized.status === "starting" || sanitized.status === "capturing") {
          captionIdleGuard.current = false;
        }
        if (sanitized.lastError && !isNoSpeechBridgeError(sanitized.lastError)) {
          captionFailureMessage.current = sanitized.lastError;
        } else if (sanitized.status === "starting" || sanitized.status === "capturing") {
          // A healthy active status clears a prior transient failure. Keep an
          // idle error until stop finishes so the failure caption is retained.
          captionFailureMessage.current = null;
        }
        // A normal idle transition ends the current live session. Clear the
        // painted caption so a later session/overlay cannot mistake it for
        // current speech. Error transitions intentionally retain the last
        // caption for diagnosis and follow the README failure contract.
        if (sanitized.status === "idle" && !sanitized.lastError && !captionFailureMessage.current) {
          setCaption(createEmptyCaption());
        }
        const statusKey = [
          sanitized.status,
          sanitized.platform,
          sanitized.backendReachable,
          sanitized.nativeOutput ?? "",
          sanitized.lastError ?? "",
        ].join("|");
        if (statusKey === lastRuntimeStatusKey.current) {
          return;
        }
        lastRuntimeStatusKey.current = statusKey;
        setStatus(sanitized);
        if (!(nextStatus.lastError && isNoSpeechBridgeError(nextStatus.lastError))) {
          pushDiagnosticEvent(
            "runtime",
            `Runtime → ${sanitized.status}`,
            sanitized.lastError ?? `backend=${String(sanitized.backendReachable)}`,
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
    captionIdleGuard.current = false;
    captionFailureMessage.current = null;
    const microphone = new MicrophoneCapture();
    const previousMicrophone = capture.current;
    capture.current = microphone;
    setNotice(null);
    clearInputLevelDb();
    clearCaptionDisplayTiming();
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
    let streamForAttempt: ParapperRecognitionStream | null = null;
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
      const preparePromise = microphone.prepareInput(
        captureConfig.audio.inputDeviceId,
        captureConfig.audio.noiseSuppression !== false,
      );
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

      const desktopStreaming = bridge.isDesktop();
      chunkProcessor.current?.reset();
      clearChunkTimingStats();
      parapperOutputChain.current = Promise.resolve();

      if (desktopStreaming) {
        const handleParapperEvent = (event: ParapperStreamEvent): void => {
          if (attempt !== captureAttempt.current || event.type === "speech.started") {
            if (event.type === "speech.started" && attempt === captureAttempt.current) {
              pushDiagnosticEvent("audio", "Parapper speech started");
            }
            return;
          }
          const output: ParapperRecognitionOutput = {
            text: event.text,
            sourceText: event.sourceText,
            sessionId: event.sessionId,
            turnSessionId: event.turnSessionId,
            turnId: event.turnId,
            revision: event.revision,
            segmentId: event.segmentId,
            previousSegmentId: event.previousSegmentId,
            sourceAsrModel: event.sourceAsrModel,
            sourceLanguage: event.sourceLanguage,
            detectedLanguage: event.detectedLanguage,
            elapsedMs: event.elapsedMs,
            audioDurationMs: event.audioDurationMs,
            isFinal: event.type === "turn.final",
          };
          const processOutput = async (): Promise<void> => {
            if (attempt !== captureAttempt.current) {
              return;
            }
            const startedAt =
              typeof performance !== "undefined" && typeof performance.now === "function"
                ? performance.now()
                : Date.now();
            try {
              const nextCaption = await bridge.normalizeParapperOutput(output);
              if (attempt !== captureAttempt.current) {
                return;
              }
              const elapsed = Math.max(
                0,
                Math.round(
                  (typeof performance !== "undefined" && typeof performance.now === "function"
                    ? performance.now()
                    : Date.now()) - startedAt,
                ),
              );
              if (!nextCaption.sourceText.trim()) {
                pushDiagnosticEvent(
                  "audio",
                  "No speech (soft-skip)",
                  `${output.sessionId} · ${elapsed}ms`,
                );
                setNotice(noticeForNoSpeech(output.sessionId));
                return;
              }
              pushDiagnosticEvent(
                "audio",
                output.isFinal ? "Parapper final normalized" : "Parapper interim normalized",
                `id=${nextCaption.id} · ${elapsed}ms · src=${nextCaption.sourceText.slice(0, 48)}`,
              );
              setCaption((current) => {
                const merged = mergeCaptionPayload(current, nextCaption);
                if (merged === null || merged === current) {
                  return current;
                }
                markCaptionDisplay(merged);
                return merged;
              });
              setStatus((current) =>
                current.lastError ? { ...current, lastError: null } : current,
              );
              setNotice((current) => (isTransientAudioNotice(current) ? null : current));
            } catch (error: unknown) {
              if (attempt !== captureAttempt.current) {
                return;
              }
              if (!shouldToastAudioProcessingFailure(error)) {
                const detail = formatBridgeError(error) ?? output.sessionId;
                pushDiagnosticEvent("audio", "No speech (soft-skip)", detail);
                setNotice(noticeForNoSpeech(detail));
                return;
              }
              const nextNotice = noticeFromError(error, "message.audioProcessingFailed");
              pushDiagnosticEvent(
                "error",
                "Audio processing failed",
                nextNotice.detail ?? t(nextNotice.key),
              );
              setNotice(nextNotice);
              captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
              setStatus((current) => ({
                ...current,
                lastError: nextNotice.detail ?? t(nextNotice.key),
              }));
            }
          };
          // Parapper's output order is significant: a later final must not be
          // normalized before an earlier interim revision has been observed.
          parapperOutputChain.current = parapperOutputChain.current
            .then(processOutput)
            .catch(() => undefined);
        };
        streamForAttempt = new ParapperRecognitionStream({
          url: DEFAULT_PARAPPER_STREAM_URL,
          onEvent: handleParapperEvent,
          onError: (error) => {
            if (attempt !== captureAttempt.current) {
              return;
            }
            const nextNotice = noticeFromError(error, "message.audioProcessingFailed");
            pushDiagnosticEvent(
              "error",
              "Parapper stream failed",
              nextNotice.detail ?? t(nextNotice.key),
            );
            captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
            setNotice(nextNotice);
            void stopCapture();
          },
        });
        await streamForAttempt.start();
        if (attempt !== captureAttempt.current) {
          streamForAttempt.cancel();
          await microphone.stop().catch(() => undefined);
          await bridge.stopCapture().catch(() => undefined);
          return;
        }
        parapperStream.current = streamForAttempt;
      } else {
        // Browser preview keeps the historical HTTP demo path. The native
        // desktop path above is the only path that talks to a real Parapper
        // sidecar, so it can preserve the continuous state machine.
        const processorRef: { current: LatestWinsProcessor<AudioChunk> | null } = { current: null };
        const processor = createLatestWinsProcessor<AudioChunk>({
          isActive: () => attempt === captureAttempt.current,
          onStatsChange: (stats) => setChunkTimingStats(stats),
          process: async (chunk, { whenFirstCaption, isCurrent }) => {
            const invokePromise = (async (): Promise<void> => {
              try {
                const nextCaption = await bridge.transcribeAudioChunk(chunk);
                if (attempt !== captureAttempt.current || !isCurrent()) return;
                if (!nextCaption.sourceText.trim()) {
                  setNotice(noticeForNoSpeech(nextCaption.id));
                  return;
                }
                processorRef.current?.markFirstCaption();
                setCaption((current) => mergeCaptionPayload(current, nextCaption) ?? current);
              } catch (error: unknown) {
                if (attempt !== captureAttempt.current || !isCurrent()) return;
                if (!shouldToastAudioProcessingFailure(error)) {
                  setNotice(noticeForNoSpeech(formatBridgeError(error)));
                  return;
                }
                const nextNotice = noticeFromError(error, "message.audioProcessingFailed");
                setNotice(nextNotice);
                captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
              }
            })();
            await Promise.race([whenFirstCaption(), invokePromise]);
            void invokePromise.catch(() => undefined);
          },
        });
        processorRef.current = processor;
        chunkProcessor.current = processor;
      }

      await microphone.start(
        captureConfig.audio.inputDeviceId,
        captureConfig.audio.chunkMs,
        captureConfig.audio.silenceGateDb,
        desktopStreaming
          ? null
          : (chunk) => {
              // MicrophoneCapture includes bounded cumulative speech context in
              // each chunk. If ASR is still busy and latest-wins drops intermediate
              // requests, the newest chunk still carries the accepted history
              // needed to decode words across every skipped capture boundary.
              chunkProcessor.current?.enqueue(chunk);
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
          captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
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
            // External store: does not re-render MainApp / caption preview.
            setInputLevelDb(rmsDb);
          }
        },
        captureConfig.audio.noiseSuppression !== false,
        {
          adaptiveGate: captureConfig.audio.adaptiveNoiseFloor !== false,
          streamPcmHandler: streamForAttempt
            ? (frame) => streamForAttempt?.sendPcm16(frame)
            : undefined,
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
      streamForAttempt?.cancel();
      if (parapperStream.current === streamForAttempt) {
        parapperStream.current = null;
      }
      await Promise.allSettled([microphone.stop(), bridge.stopCapture()]);
      if (attempt !== captureAttempt.current) {
        return;
      }
      captionIdleGuard.current = true;
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
      captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
    }
  };

  const stopCapture = async () => {
    // Keep the current attempt valid through microphone.stop(). AudioCapture
    // flushes a speech-aware partial tail from its pending buffer, and the
    // handler must still be allowed to enqueue that tail into the processor.
    // Invalidating/resetting first silently drops the final sub-window.
    const stoppingAttempt = captureAttempt.current;
    const microphone = capture.current;
    const processor = chunkProcessor.current;
    const stream = parapperStream.current;
    clearInputLevelDb();
    pushDiagnosticEvent("audio", "Capture stopping");
    let microphoneFailure: unknown = null;
    try {
      await microphone.stop();
    } catch (error) {
      microphoneFailure = error;
      captionFailureMessage.current = formatBridgeError(error) ?? "microphone stop failed";
    }

    // A newer start/stop owns the processor now. Do not invalidate its attempt
    // or invoke bridge.stopCapture() after it has begun a replacement session.
    if (captureAttempt.current !== stoppingAttempt) {
      return;
    }

    // The tail handler above only enqueues; drain the latest-wins queue while
    // this attempt is still active so the final chunk can reach ASR. A reset
    // before this await would resolve whenIdle by dropping the queued work.
    if (processor) {
      try {
        await processor.whenIdle();
      } catch (error) {
        microphoneFailure ??= error;
        captionFailureMessage.current = formatBridgeError(error) ?? "caption queue drain failed";
      }
    }

    // Graceful Parapper stop closes the audio input, drains its recognition
    // worker, and emits the final Turn before session.done. Wait for the native
    // AzooKey chain as well so the final Hiragana→Kanji caption/translation is
    // not discarded when the attempt is invalidated below.
    if (stream) {
      try {
        await stream.stop();
      } catch (error) {
        microphoneFailure ??= error;
        captionFailureMessage.current = formatBridgeError(error) ?? "Parapper stream stop failed";
      }
      try {
        await parapperOutputChain.current;
      } catch (error) {
        microphoneFailure ??= error;
        captionFailureMessage.current = formatBridgeError(error) ?? "Parapper output drain failed";
      }
      if (parapperStream.current === stream) {
        parapperStream.current = null;
      }
    }
    if (captureAttempt.current !== stoppingAttempt) {
      return;
    }

    // Invalidate late invoke completions/events only after the queue drained.
    captureAttempt.current += 1;
    captionIdleGuard.current = true;
    processor?.reset();
    if (chunkProcessor.current === processor) {
      chunkProcessor.current = null;
    }
    clearChunkTimingStats();
    clearCaptionDisplayTiming();
    if (capture.current === microphone) {
      capture.current = new MicrophoneCapture();
    }

    let bridgeFailure: unknown = null;
    try {
      await bridge.stopCapture();
    } catch (error) {
      bridgeFailure = error;
    }

    // A replacement session may have started while the backend was stopping;
    // its status/caption must not be overwritten by this stale stop result.
    const invalidatedAttempt = stoppingAttempt + 1;
    if (captureAttempt.current !== invalidatedAttempt) {
      return;
    }

    const failure = microphoneFailure ?? bridgeFailure;
    if (!failure) {
      pushDiagnosticEvent("audio", "Capture stopped");
      const retainedFailure = captionFailureMessage.current;
      if (retainedFailure) {
        // A successful microphone/backend teardown does not erase evidence of
        // an earlier ASR/translation failure. Keep the caption and surface the
        // error while transitioning to idle.
        setStatus((current) => ({ ...current, status: "idle", lastError: retainedFailure }));
      } else {
        setCaption(createEmptyCaption());
        setStatus((current) => ({ ...current, status: "idle", lastError: null }));
      }
    } else {
      const nextNotice = noticeFromError(failure, "message.microphoneStopFailed");
      captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
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
            <div className="build-meta" data-testid="build-info">
              <span data-testid="build-version">v{BUILD_INFO.appVersion}</span>
              <span aria-hidden="true">·</span>
              <span data-testid="build-id">build {BUILD_INFO.buildId}</span>
            </div>
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
              Tauri 2 <span>·</span> native runtime
            </div>
          </div>
        </aside>
        <main className="content">
          {activeTab === "live" ? (
            <>
              <LiveView
                config={config}
                status={status}
                caption={caption}
                devices={devices}
                message={noticeText}
                onToggleCapture={toggleCapture}
                onOpenOverlay={() => void openOverlay()}
                onDeviceChange={handleDeviceChange}
                onRefreshDevices={() => void refreshDevices({ primePermission: true })}
                onCloseMessage={() => setNotice(null)}
              />
              {/*
               * Keep the stage inspector reachable from the normal live
               * workspace.  Capturing starts on this same mount, so ASR /
               * normalizer /
               * translator rows keep updating even when Settings is never
               * opened.  SettingsView still renders the same panel when
               * users prefer to inspect it alongside model configuration.
               */}
              <DebugPanel />
            </>
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
