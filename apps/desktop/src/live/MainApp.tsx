import type { ChangeEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import {
  ensureMicrophoneAccess,
  enumerateAudioInputDevices,
  formatAudioCaptureDiagnostics,
  MicrophoneCapture,
  TARGET_SAMPLE_RATE,
} from "../core/audio";
import { bridge, formatBridgeError, isNoSpeechBridgeError } from "../core/bridge";
import { shouldApplyCaptionHoldClear } from "../core/caption-hold-clear";
import {
  asrLatencyFromUnknown,
  markCaptionIpcReceived,
  parseNumericTurnId,
} from "../core/caption-latency";
import {
  clearCaptionMergeDiagnostics,
  getCaptionMergeDiagnostics,
  mergeCaptionPayload,
  takePendingCaptionTranslation,
} from "../core/caption-updates";
import {
  type CaptureStartBlockReason,
  canStartCaptionCapture,
  resolveCaptureStartBlockReason,
  resolveParapperHealthyFromSidecars,
} from "../core/capture-start-readiness";
import {
  clearChunkTimingStats,
  createLatestWinsProcessor,
  type LatestWinsProcessor,
  setChunkTimingStats,
} from "../core/chunkQueue";
import {
  createDefaultConfig,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_RECOGNITION_MODE,
  DEFAULT_RUNTIME_STATUS,
  ENDPOINT_TIMEOUT_MAX_MS,
  ENDPOINT_TIMEOUT_MIN_MS,
  isRecognitionMode,
  resolveSilenceGateMode,
} from "../core/defaults";
import {
  beginCaptureStartupCorrelation,
  markCaptureFirstCaption,
  markCaptureFirstForwardedPcm,
  markCaptureFirstSpeech,
  markCapturePrerollStats,
  markCaptureSessionReady,
  pushDiagnosticEvent,
} from "../core/diagnostics";
import { clearCaptionDisplayTiming, markCaptionDisplay } from "../core/display-timing";
import {
  clearPipelineDrops,
  type PipelineDropSignal,
  recordCaptureStartupDiscard,
  recordPipelineDrop,
} from "../core/dropDiagnostics";
import { clearInputLevelDb, setInputLevelDb } from "../core/input-level";
import {
  isTransientAudioNotice,
  type Notice,
  noticeForNoSpeech,
  noticeFromError,
  shouldToastAudioProcessingFailure,
} from "../core/notices";
import { createParapperOutputQueue, type ParapperOutputQueue } from "../core/parapper-output-queue";
import {
  buildParapperProvisionalCaption,
  buildProvisionalCaptionFromAsrStage,
} from "../core/parapper-provisional";
import {
  DEFAULT_PARAPPER_STREAM_URL,
  ParapperRecognitionStream,
  type ParapperStreamEvent,
  selectParapperSurfaceText,
} from "../core/parapperStream";
import {
  hydratePipelineStageEvents,
  pushPendingCaptionTranslationStage,
  pushPipelineStageEvent,
} from "../core/pipelineStages";
import { appendStructuredLog } from "../core/structuredLog";
import type {
  AppConfig,
  AudioChunk,
  AudioInputDevice,
  CaptionPayload,
  ModelCatalog,
  ModelFamily,
  ParapperRecognitionOutput,
  RecognitionMode,
  RuntimeStatus,
} from "../core/types";
import {
  getWebSpeechRecognitionDiagnostics,
  isWebSpeechRecognitionSupported,
  queryWebSpeechRecognitionPermission,
  type WebSpeechRecognitionResult,
  WebSpeechRecognitionStream,
  type WebSpeechRecognitionStreamEvent,
} from "../core/webSpeechRecognition";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import {
  createEmptyCaption,
  createHoldClearedCaption,
  createPreviewCaption,
} from "../overlay/captions";
import { NativeFramePublisher } from "../overlay/NativeFramePublisher";
import { SettingsView } from "../settings/SettingsView";
import { LiveView } from "./LiveView";
import { useCaptionHoldClear } from "./useCaptionHoldClear";
import { useProgressiveCaptionReveal } from "./useProgressiveCaptionReveal";

type ActiveTab = "live" | "settings";

type CapturePhase = "idle" | "starting" | "capturing" | "stopping";

/** Keep only the newest Web Speech result for each result slot while native startup drains. */
export const MAX_BUFFERED_WEB_SPEECH_RESULTS = 32;

/** Return whether a live capture must be rebuilt to apply the new settings. */
export const captureConfigRequiresRestart = (before: AppConfig, after: AppConfig): boolean =>
  before.recognitionMode !== after.recognitionMode ||
  before.audio.inputDeviceId !== after.audio.inputDeviceId ||
  before.audio.noiseSuppression !== after.audio.noiseSuppression ||
  before.audio.autoGainControl !== after.audio.autoGainControl ||
  before.audio.adaptiveNoiseFloor !== after.audio.adaptiveNoiseFloor ||
  before.audio.chunkMs !== after.audio.chunkMs ||
  before.audio.silenceGateDb !== after.audio.silenceGateDb;

/**
 * Bound renderer-side ASR invokes as a last line of defence.
 *
 * The native command normally applies the configured gateway timeout itself,
 * but a hung IPC call would otherwise keep the latest-wins flight alive
 * forever.  The timeout only rejects the renderer promise; the underlying
 * invoke is still observed by the caller so a late rejection cannot become an
 * unhandled promise.
 */
export const TRANSCRIBE_AUDIO_CHUNK_DEFAULT_TIMEOUT_MS = 18_000;

export const resolveTranscribeAudioChunkTimeoutMs = (configured: number): number => {
  if (!Number.isFinite(configured) || configured <= 0) {
    return TRANSCRIBE_AUDIO_CHUNK_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(
    ENDPOINT_TIMEOUT_MAX_MS,
    Math.max(ENDPOINT_TIMEOUT_MIN_MS, Math.round(configured)),
  );
};

export const withFiniteTimeout = <T,>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  label = "operation timed out",
  onLateReject?: (error: unknown) => void,
): Promise<T> => {
  const boundedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.max(1, Math.round(timeoutMs))
      : TRANSCRIBE_AUDIO_CHUNK_DEFAULT_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const error = new Error(`${label} (${boundedTimeout}ms)`);
      error.name = "TimeoutError";
      reject(error);
    }, boundedTimeout);
    Promise.resolve(operation).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          try {
            onLateReject?.(error);
          } catch {
            // Late-error telemetry must not create a second unhandled reject.
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
};

/** Clear only transient ASR/audio notices once legacy recognition succeeds. */
export const clearLegacyFailureNotice = (notice: Notice | null): Notice | null =>
  isTransientAudioNotice(notice) ? null : notice;

/**
 * Latest-wins coalescing for capture stop→start restarts.
 *
 * Rapid device/config changes must not attach multiple `.then(startCapture)`
 * callbacks to the same stop promise: the first callback sets phase to
 * `starting` and later callbacks hit the non-idle guard and silently drop the
 * newest config. This coordinator keeps a single pending slot and a single
 * drain loop so the latest request always wins.
 */
export type CaptureRestartCoordinatorOptions<TConfig> = {
  stop: () => Promise<void>;
  start: (config: TConfig) => Promise<void>;
  /** Newest config could not be applied and no newer request replaced it. */
  onApplyFailed?: (config: TConfig, error: unknown) => void;
};

export type CaptureRestartCoordinator<TConfig> = {
  requestRestart: (config: TConfig) => void;
  /**
   * Drop any pending restart and invalidate the in-flight drain's planned
   * start. Explicit user stop must call this so a coalesced start cannot
   * resurrect capture after the toggle to idle.
   */
  cancelPending: () => void;
  /** True while stop/start work is outstanding or a request is pending. */
  isBusy: () => boolean;
  getPending: () => TConfig | null;
};

export const createCaptureRestartCoordinator = <TConfig,>(
  options: CaptureRestartCoordinatorOptions<TConfig>,
): CaptureRestartCoordinator<TConfig> => {
  let pending: TConfig | null = null;
  let draining = false;
  /** Bumped only on cancel so an explicit stop can skip a planned start. */
  let epoch = 0;

  const drain = async (): Promise<void> => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (pending !== null) {
        let config = pending;
        const requestEpoch = epoch;
        pending = null;
        try {
          await options.stop();
        } catch (error) {
          // Cancelled during stop: leave any later pending for the next loop.
          if (epoch !== requestEpoch) {
            continue;
          }
          // Superseded during a failed stop: retry with the newest config.
          if (pending !== null) {
            continue;
          }
          options.onApplyFailed?.(config, error);
          continue;
        }
        // Explicit user cancel must not start the config that was in flight.
        if (epoch !== requestEpoch) {
          continue;
        }
        // A newer request arrived during stop: reuse this stop, start newest.
        if (pending !== null) {
          config = pending;
          pending = null;
        }
        try {
          await options.start(config);
        } catch (error) {
          if (pending !== null || epoch !== requestEpoch) {
            continue;
          }
          options.onApplyFailed?.(config, error);
        }
      }
    } finally {
      draining = false;
      // A request that arrived between the last pending clear and this flag
      // flip must not be stranded without a drain.
      if (pending !== null) {
        void drain();
      }
    }
  };

  return {
    requestRestart(config) {
      // Overwrite only — do not bump epoch. Latest-wins is the pending slot;
      // epoch is reserved for cancelPending so user stop can veto a start.
      pending = config;
      void drain();
    },
    cancelPending() {
      pending = null;
      epoch += 1;
    },
    isBusy: () => draining || pending !== null,
    getPending: () => pending,
  };
};

const statusKeys: Record<RuntimeStatus["status"], MessageKey> = {
  idle: "status.idle",
  starting: "status.starting",
  capturing: "status.capturing",
  error: "status.error",
};

const webSpeechLanguage = (source: string): string => {
  const value = source.trim();
  if (!value) {
    return "ja-JP";
  }
  if (value.includes("-")) {
    return value;
  }
  const defaults: Record<string, string> = {
    ja: "ja-JP",
    en: "en-US",
    ko: "ko-KR",
    zh: "zh-CN",
    fr: "fr-FR",
    de: "de-DE",
    es: "es-ES",
  };
  return defaults[value.toLowerCase()] ?? value;
};

/**
 * Merge a caption for the live view, allowing the first native replay to replace
 * the design-time preview even when that caption's timestamps predate mount.
 * Subsequent updates still use the normal ordering/translation guards.
 */
export const mergeCaptionForDisplay = (
  current: CaptionPayload,
  incoming: CaptionPayload,
  bootstrapPreview = false,
): CaptionPayload | null => {
  if (bootstrapPreview && current.id === "preview") {
    return incoming.sourceText.trim() || incoming.translationText.trim() ? incoming : null;
  }
  return mergeCaptionPayload(current, incoming);
};

/**
 * Keep provisional ASR paints inside the capture generation that produced them.
 * Older native workers may finish after Stop and still emit diagnostic stage rows;
 * those rows remain useful in the Debug panel, but must not repaint the live view.
 * Events from older bundles without a generation remain display-compatible.
 */
export const acceptsPipelineStageGeneration = (
  eventGeneration: number | null | undefined,
  activeGeneration: number | null,
): boolean => eventGeneration == null || eventGeneration === activeGeneration;

/**
 * Release the HTTP chunk queue once a source caption actually painted.
 * Provisional ASR uses the same gate as normalized source so the next chunk
 * is not head-of-line blocked while AzooKey still runs.
 */
export const shouldReleaseChunkQueueAfterSourcePaint = (
  painted: boolean,
  sourceText: string,
): boolean => painted && Boolean(sourceText.trim());

/** Record and surface one native queue-drop signal on the normal Live screen. */
export const handlePipelineDropSignal = (
  drop: PipelineDropSignal,
  notify: (notice: Notice) => void,
): void => {
  recordPipelineDrop(drop.source, drop.count, drop.reason);
  const detail = `source=${drop.source} · reason=${drop.reason} · count=${drop.count}`;
  notify({ key: "message.pipelineDrop", detail });
};

/** Mirror exactly one diagnostic when a new cross-ID translation is retained. */
export const reportCrossIdTranslationSaved = (
  beforeSaved: number,
  afterSaved: number,
  captionId: string,
  pendingCount: number,
): void => {
  if (afterSaved <= beforeSaved) {
    return;
  }
  pushDiagnosticEvent(
    "caption",
    "Late translation preserved for prior utterance",
    `${captionId} · pending=${pendingCount}`,
    { mirrorStructured: false },
  );
};

/** Low-priority drop notices yield to real capture/microphone failures. */
export const shouldShowPipelineDropNotice = (
  alreadyShown: boolean,
  current: Notice | null,
  lastError: string | null = null,
): boolean =>
  !alreadyShown &&
  !(lastError?.trim() && !isNoSpeechBridgeError(lastError)) &&
  (!current ||
    current.key === "message.noSpeechDetected" ||
    current.key === "message.pipelineDrop");

/**
 * Resolve the message shown in the live workspace.
 *
 * Renderer notices are intentionally lower priority than a persistent runtime
 * error, which must remain visible even when a drop or soft-skip event races
 * its status update.
 */
export const resolveLiveNoticeText = (
  notice: Notice | null,
  lastError: string | null,
  translate: (key: MessageKey) => string,
): string | null => {
  const fatalLastError = lastError && !isNoSpeechBridgeError(lastError) ? lastError : null;
  // Runtime failures are the highest-priority live signal. Do this check
  // before rendering any renderer-side notice (including a stale no-speech or
  // pipeline-drop banner) so a status event cannot be hidden by an older
  // low-priority message. A capture error notice typically carries the same
  // detail, so returning the status text is still lossless in that case.
  if (fatalLastError) {
    if (notice?.detail?.trim() === fatalLastError.trim()) {
      return [translate(notice.key), notice.detail].filter((part) => part).join(" ");
    }
    return fatalLastError;
  }
  return notice
    ? [translate(notice.key), notice.detail].filter((part) => part).join(" ")
    : fatalLastError;
};

export const MainApp = () => {
  const { t } = useI18n();
  const [config, setConfig] = useState<AppConfig>(createDefaultConfig);
  const [models, setModels] = useState<ModelCatalog>(DEFAULT_MODEL_CATALOG);
  const [status, setStatus] = useState<RuntimeStatus>(DEFAULT_RUNTIME_STATUS);
  /** Mutable caption cursor keeps merge side effects outside React state updaters. */
  const captionRef = useRef<CaptionPayload>(createPreviewCaption());
  const [caption, setCaption] = useState<CaptionPayload>(() => captionRef.current);
  // Grow newly recognized graphemes onto Live/Syphon one-by-one (こ→こんにちは).
  // Hold-clear still watches the merged `caption`; display paths use the reveal.
  const progressiveCaption = useProgressiveCaptionReveal(caption);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>("live");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [transparentCaptureOpen, setTransparentCaptureOpen] = useState(false);
  const [startBlockReason, setStartBlockReason] =
    useState<CaptureStartBlockReason>("models-preparing");
  /** Avoid training users to ignore a repeated low-priority drop banner. */
  const pipelineDropNoticeShown = useRef(false);
  /** Keep an accepted drop token so React StrictMode updater replays are idempotent. */
  const pipelineDropNoticeAccepted = useRef<Notice | null>(null);
  /** Keep the latest runtime error available to long-lived bridge listeners. */
  const runtimeStatusRef = useRef<RuntimeStatus>(DEFAULT_RUNTIME_STATUS);
  runtimeStatusRef.current = status;
  const capture = useRef(new MicrophoneCapture());
  const captureAttempt = useRef(0);
  /** Lifecycle guard shared by starts/stops that outlive a React render. */
  const capturePhase = useRef<CapturePhase>("idle");
  /** Make repeated stop clicks idempotent while teardown is draining. */
  const stopPromise = useRef<Promise<void> | null>(null);
  /** Native start command that a startup stop must let settle before stopping. */
  const backendStartPromise = useRef<Promise<number> | null>(null);
  /**
   * Stable restart hooks. startCapture/stopCapture are re-bound each render;
   * the coordinator itself is created once so rapid events share one drain.
   */
  const startCaptureRef = useRef<(captureConfig: AppConfig) => Promise<void>>(
    async () => undefined,
  );
  const stopCaptureRef = useRef<() => Promise<void>>(async () => undefined);
  const captureRestartRef = useRef(
    createCaptureRestartCoordinator<AppConfig>({
      stop: () => stopCaptureRef.current(),
      start: (captureConfig) => startCaptureRef.current(captureConfig),
      onApplyFailed: (_captureConfig, error) => {
        const nextNotice = noticeFromError(error, "message.captureStartFailed");
        pushDiagnosticEvent(
          "error",
          "Capture restart failed to apply latest config",
          nextNotice.detail ?? nextNotice.key,
        );
        setNotice(nextNotice);
      },
    }),
  );
  /** Latest-wins ASR queue: 1 in-flight + 1 pending (drop older pending). */
  const chunkProcessor = useRef<LatestWinsProcessor<AudioChunk> | null>(null);
  /** One continuous Parapper VAD/Segment/Turn session for desktop capture. */
  const parapperStream = useRef<ParapperRecognitionStream | null>(null);
  /** Browser Web Speech stream used by the explicit debug recognition mode. */
  const webSpeechStream = useRef<WebSpeechRecognitionStream | null>(null);
  /** Aggregate Web Speech result slots until the browser ends one session. */
  const webSpeechResults = useRef<Map<number, string>>(new Map());
  const webSpeechCaptionId = useRef<string | null>(null);
  const webSpeechStartedAt = useRef<number>(0);
  const webSpeechPublishChain = useRef<Promise<void>>(Promise.resolve());
  /**
   * Preserve final turn order while coalescing high-frequency partials. A
   * Promise chain would queue every interim revision and delay the final
   * caption behind stale AzooKey normalizations.
   */
  const parapperOutputQueue = useRef<ParapperOutputQueue<ParapperRecognitionOutput> | null>(null);
  /** Avoid runtime:status re-renders when the backend re-emits an identical snapshot. */
  const lastRuntimeStatusKey = useRef<string>("");
  /** Ignore caption events that arrive after a stop/idle transition. */
  const captionIdleGuard = useRef(false);
  /**
   * Native capture generation that currently owns the visible caption. Set only
   * after `start_capture` resolves, cleared on stop/teardown. Diagnostic stage
   * rows from a superseded generation stay in the Debug panel, but must not
   * repaint the live view of a replacement session.
   */
  const activeCaptureGeneration = useRef<number | null>(null);
  /** Preserve the last caption when processing reported a real failure. */
  const captionFailureMessage = useRef<string | null>(null);
  /** Initialization barrier used to order latest-caption replay after status. */
  const initialRuntimeReady = useRef<Promise<void>>(Promise.resolve());

  /**
   * Merge and publish outside React's functional state updater. `mergeCaptionPayload`
   * records late cross-ID translations in a bounded side channel; doing that work
   * inside `setCaption(current => ...)` would duplicate entries when React replays
   * an updater in StrictMode/concurrent rendering.
   */
  const mergeAndCommitCaption = useCallback(
    (incoming: CaptionPayload, bootstrapPreview = false): boolean => {
      const current = captionRef.current;
      const merged = mergeCaptionForDisplay(current, incoming, bootstrapPreview);
      if (merged === null || merged === current) {
        return false;
      }
      captionRef.current = merged;
      markCaptionIpcReceived(merged.id, {
        turnId: parseNumericTurnId(merged.id),
        asrLatency: merged.asrLatency ?? asrLatencyFromUnknown(incoming),
      });
      markCaptionDisplay(merged);
      setCaption(merged);
      return true;
    },
    [],
  );

  /** Reset the visible caption and any retained translation from this session. */
  const clearCaptionState = useCallback((): void => {
    const empty = createEmptyCaption();
    captionRef.current = empty;
    setCaption(empty);
    clearCaptionMergeDiagnostics();
  }, []);

  /** Blank the plate after hold without tearing down merge diagnostics / session. */
  const blankDisplayedCaption = useCallback((expectedEpoch: string): void => {
    const current = captionRef.current;
    if (!shouldApplyCaptionHoldClear(expectedEpoch, current)) {
      return;
    }
    if (!current.sourceText.trim() && !current.translationText.trim()) {
      return;
    }
    const empty = createHoldClearedCaption();
    captionRef.current = empty;
    setCaption(empty);
  }, []);

  useCaptionHoldClear(caption, blankDisplayedCaption);

  // A later ambient soft-skip must not replace the visible notice from a
  // persistent ASR result-loss error. A real caption clears this ref through
  // the normal healthy status path, at which point no-speech notices resume.
  const showNoSpeechNotice = (detail?: string): void => {
    if (!captionFailureMessage.current) {
      setNotice(noticeForNoSpeech(detail));
    }
  };

  const refreshDevices = useCallback(async (options?: { primePermission?: boolean }) => {
    try {
      if (options?.primePermission) {
        try {
          // First await from the Refresh click must be getUserMedia so WKWebView
          // can show the OS microphone dialog (later awaits lose the gesture).
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
    let bootstrappedFromConfigUpdate = false;
    const disposers: Array<() => void> = [];
    const bootstrapConfigListener = bridge
      .listenConfig((nextConfig) => {
        if (!mounted) {
          return;
        }
        bootstrappedFromConfigUpdate = true;
        setConfig(nextConfig);
        pushDiagnosticEvent(
          "config",
          "Config updated",
          `translator=${nextConfig.models.translator}`,
        );
      })
      .then((dispose) => {
        if (mounted) {
          disposers.push(dispose);
        } else {
          dispose();
        }
        return dispose;
      })
      .catch((error: unknown) => {
        if (mounted) {
          pushDiagnosticEvent(
            "error",
            "Config listen failed",
            formatBridgeError(error) ?? String(error),
          );
        }
      });
    void bootstrapConfigListener.catch(() => undefined);
    initialRuntimeReady.current = Promise.all([
      bridge.getConfig(),
      bridge.getModels(),
      bridge.getStatus(),
      bootstrapConfigListener,
    ])
      .then(([nextConfig, nextModels, nextStatus]) => {
        if (!mounted) {
          return;
        }
        if (!bootstrappedFromConfigUpdate) {
          setConfig(nextConfig);
        }
        setModels(nextModels);
        setStatus(nextStatus);
        runtimeStatusRef.current = nextStatus;
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
      for (const dispose of disposers) {
        dispose();
      }
      capturePhase.current = "stopping";
      activeCaptureGeneration.current = null;
      const cleanupAttempt = ++captureAttempt.current;
      const backendStart = backendStartPromise.current;
      parapperStream.current?.cancel();
      parapperStream.current = null;
      webSpeechStream.current?.cancel();
      webSpeechStream.current = null;
      webSpeechResults.current.clear();
      webSpeechCaptionId.current = null;
      clearCaptionMergeDiagnostics();
      void capture.current.stop().catch(() => undefined);
      // A component can unmount while `start_capture` is still in flight. Wait
      // for that command, then stop only if no newer generation superseded this
      // cleanup. This prevents a late startup completion from resurrecting the
      // native runtime while guaranteeing unmount tears it down.
      void (async () => {
        try {
          await backendStart;
        } catch {
          // Startup failure is already reported by its owner; teardown still
          // needs to release any partially-created native session.
        }
        if (captureAttempt.current !== cleanupAttempt) {
          return;
        }
        await bridge.stopCapture().catch(() => undefined);
      })();
    };
  }, [refreshDevices]);

  // Disable Start until required ASR models are ready and Parapper is healthy.
  // Poll faster while blocked (e.g. Nemotron download) so the button re-enables promptly.
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let downloadUnlisten: (() => void) | null = null;

    const clearTimer = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = (reason: CaptureStartBlockReason) => {
      clearTimer();
      if (!mounted) {
        return;
      }
      const phase = runtimeStatusRef.current.status;
      const capturing = phase === "capturing" || phase === "starting";
      const delayMs = capturing ? 15_000 : reason != null ? 2_000 : 8_000;
      timer = setTimeout(() => {
        void refreshReadiness();
      }, delayMs);
    };

    const refreshReadiness = async () => {
      const [modelStatus, diagnostics] = await Promise.all([
        bridge.listModelStatus().catch(() => null),
        bridge.getRuntimeDiagnostics().catch(() => null),
      ]);
      if (!mounted) {
        return;
      }
      const reason = resolveCaptureStartBlockReason({
        recognitionMode: config.recognitionMode,
        streamingInterimAsrEnabled: config.audio.streamingInterimAsrEnabled === true,
        modelStatus: modelStatus ?? [],
        parapperHealthy: resolveParapperHealthyFromSidecars(diagnostics?.sidecars),
        webSpeechSupported: isWebSpeechRecognitionSupported(),
      });
      setStartBlockReason((previous) => (previous === reason ? previous : reason));
      scheduleNext(reason);
    };

    void refreshReadiness();
    void bridge
      .listenDownloadProgress(() => {
        if (mounted) {
          void refreshReadiness();
        }
      })
      .then((dispose) => {
        if (mounted) {
          downloadUnlisten = dispose;
        } else {
          dispose();
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
      clearTimer();
      downloadUnlisten?.();
    };
  }, [config.audio.streamingInterimAsrEnabled, config.recognitionMode]);

  useEffect(() => {
    let mounted = true;
    // React StrictMode intentionally runs mount effects once, cleans them up,
    // then runs them again in development. The first cleanup marks the shared
    // lifecycle as stopping; reset that transient marker for the real mount so
    // the first user click is not incorrectly ignored as a duplicate start.
    capturePhase.current = "idle";
    const disposers: Array<() => void> = [];
    let lastCaptionId: string | null = null;
    const captionListenerPromise = bridge
      .listenCaptions((nextCaption) => {
        if (!mounted) {
          return;
        }
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
        const beforeCrossIdSaved = getCaptionMergeDiagnostics().crossIdTranslationIdsSaved;
        // Merge every event (source and translation stage alike); only the
        // painted-source flag is gated on stage so TTFS stays tied to source.
        const painted = mergeAndCommitCaption(nextCaption);
        const paintedProgressiveSource =
          isSourceStage &&
          shouldReleaseChunkQueueAfterSourcePaint(painted, captionRef.current.sourceText);
        const afterMergeDiagnostics = getCaptionMergeDiagnostics();
        // A cross-ID translation is retained in a bounded side channel so it
        // cannot be mis-attributed to the current live caption. Report only a
        // newly saved ID; later revisions of that ID must stay quiet.
        reportCrossIdTranslationSaved(
          beforeCrossIdSaved,
          afterMergeDiagnostics.crossIdTranslationIdsSaved,
          nextCaption.id,
          afterMergeDiagnostics.pendingCrossIdTranslations,
        );
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
        // Consume pending cross-id translations that arrived before their newer source.
        // Gate empty/whitespace id to avoid Map entries for placeholder/silence payloads.
        if (nextCaption.id.trim() && nextCaption.sourceText.trim()) {
          const pending = takePendingCaptionTranslation(nextCaption.id);
          if (pending) {
            // Keep the recovered translation in the same utterance/stage history
            // as native rows (DebugPanel groups by utteranceId) without
            // attaching it to the visible live caption. The synthetic translate
            // row must never feed back into caption rendering.
            pushPendingCaptionTranslationStage(pending, nextCaption.sourceText);
            // Log that a late translation was retained for this utterance id.
            // Keep only char counts: the chunkId correlates with the caption
            // store and pipeline stage history, which already gate speech
            // samples behind the verbose privacy toggle.
            appendStructuredLog({
              level: "info",
              source: "frontend",
              message: "Late translation retained for utterance",
              chunkId: nextCaption.id,
              fields: {
                translationChars: pending.translationText.length,
                sourceChars: nextCaption.sourceText.length,
              },
            });
          }
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
    // Register the caption listener and settle the initial runtime status
    // before replaying the latest caption. Otherwise a replay can race the
    // status snapshot/listener and be immediately cleared or painted stale.
    void Promise.all([initialRuntimeReady.current, captionListenerPromise]).then(async () => {
      if (!mounted) {
        return;
      }
      const latest = await bridge.getLatestCaption().catch(() => null);
      if (!mounted || !latest || captionIdleGuard.current) {
        return;
      }
      const replayed = mergeAndCommitCaption(latest, true);
      if (replayed) {
        lastCaptionId = latest.id;
        pushDiagnosticEvent("caption", "Latest caption replayed", latest.id);
      }
    });
    // Fine-grained ASR / normalize / translate events for Debug mode.
    // Keep the subscription app-wide so the panel can stay open for continuous inspection.
    void bridge
      .listenPipelineStages((stageEvent) => {
        if (!mounted) {
          return;
        }
        pushPipelineStageEvent(stageEvent);
        // Progressive first paint: raw ASR text is available well before the
        // normalizer finishes, and the backend never sends it over the
        // caption:update channel (it stays debug-only there). Paint it here,
        // client-side, as a low-emphasis provisional caption on the same
        // utterance id; mergeCaptionPayload upgrades it in place (same id, no
        // new caption entry) once the real normalized `source` caption
        // arrives below. A successful paint also releases the HTTP chunk
        // queue so the next chunk is not blocked on AzooKey.
        if (
          !captionIdleGuard.current &&
          acceptsPipelineStageGeneration(
            stageEvent.captureGeneration,
            activeCaptureGeneration.current,
          )
        ) {
          const provisional = buildProvisionalCaptionFromAsrStage(stageEvent, {
            sourceLanguage: captionRef.current.sourceLanguage,
            targetLanguage: captionRef.current.targetLanguage,
          });
          if (provisional) {
            const painted = mergeAndCommitCaption(provisional);
            if (shouldReleaseChunkQueueAfterSourcePaint(painted, captionRef.current.sourceText)) {
              chunkProcessor.current?.markFirstCaption();
            }
          }
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
      .listenPipelineDrops((drop) => {
        if (!mounted) {
          return;
        }
        // Keep the signal visible on the normal Live screen; DebugPanel still
        // retains the bounded per-source/per-reason history for investigation.
        handlePipelineDropSignal(drop, (nextNotice) => {
          setNotice((current) => {
            // A drop is diagnostic back-pressure, not a replacement for a
            // capture/microphone failure. It may replace only a prior silence
            // or drop notice in this capture session.
            // React may replay the same functional updater in StrictMode. If
            // this exact notice was already accepted, replay the same value
            // after rechecking that no fatal notice/status won the race.
            if (pipelineDropNoticeAccepted.current === nextNotice) {
              return shouldShowPipelineDropNotice(
                false,
                current,
                runtimeStatusRef.current.lastError || captionFailureMessage.current,
              )
                ? nextNotice
                : current;
            }
            if (
              !shouldShowPipelineDropNotice(
                pipelineDropNoticeShown.current,
                current,
                runtimeStatusRef.current.lastError || captionFailureMessage.current,
              )
            ) {
              return current;
            }
            // Consume the per-session gate only when this updater actually
            // paints the low-priority notice. A fatal notice/status can race
            // the drop event; that drop must remain eligible after recovery.
            pipelineDropNoticeAccepted.current = nextNotice;
            pipelineDropNoticeShown.current = true;
            return nextNotice;
          });
        });
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
            "Pipeline drop listen failed",
            formatBridgeError(error) ?? String(error),
          );
        }
      });
    void bridge
      .listenRuntime((nextStatus) => {
        if (!mounted) {
          return;
        }
        // Ambient / no-speech chunks must never pin a fatal lastError in the UI.
        // Keep the detail in the debug event log only.
        const sanitized =
          nextStatus.lastError && isNoSpeechBridgeError(nextStatus.lastError)
            ? { ...nextStatus, lastError: null }
            : nextStatus;
        runtimeStatusRef.current = sanitized;
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
        // An idle transition ends the current live session. Clear the painted
        // caption so a later session/overlay cannot mistake it for current
        // speech. Error transitions intentionally retain the last caption for
        // diagnosis (README failure contract), but every idle boundary must
        // still drop pending cross-id translations so a same-id lookup in a
        // later session cannot pick up a stale entry.
        if (sanitized.status === "idle") {
          if (sanitized.lastError || captionFailureMessage.current) {
            clearCaptionMergeDiagnostics();
          } else {
            clearCaptionState();
          }
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
    return () => {
      mounted = false;
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [clearCaptionState, mergeAndCommitCaption]);

  const persistConfigLive = async (nextConfig: AppConfig, reason: string) => {
    try {
      await bridge.saveConfig(nextConfig);
      pushDiagnosticEvent("config", reason);
      setNotice({ key: "message.saved" });
    } catch (error) {
      const notice = noticeFromError(error, "message.saveFailed");
      pushDiagnosticEvent("error", `${reason} failed`, notice.detail ?? notice.key);
      setNotice(notice);
    }
  };

  const setModel = (family: ModelFamily, value: string) => {
    const next = { ...config, models: { ...config.models, [family]: value } };
    setConfig(next);
    // Persist and reconcile sidecars immediately so a mid-capture model swap
    // takes effect on the next caption without Stop → Start.
    void persistConfigLive(next, `Model applied live (${family}=${value})`);
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
    // A replacement start is queued by the device/mode handlers only after
    // stopCapture() resolves.  Ignore accidental duplicate starts while the
    // current lifecycle is still preparing or draining.
    if (capturePhase.current !== "idle") {
      pushDiagnosticEvent("audio", "Capture start ignored", `phase=${capturePhase.current}`);
      return;
    }
    if (!canStartCaptionCapture(startBlockReason)) {
      pushDiagnosticEvent(
        "audio",
        "Capture start blocked",
        `reason=${startBlockReason ?? "unknown"}`,
      );
      return;
    }
    const recognitionMode: RecognitionMode = isRecognitionMode(captureConfig.recognitionMode)
      ? captureConfig.recognitionMode
      : DEFAULT_RECOGNITION_MODE;
    const webSpeechMode = recognitionMode === "web-speech";
    const parapperRawMode = recognitionMode === "parapper-raw";
    const webSpeechSupported = webSpeechMode ? isWebSpeechRecognitionSupported() : true;
    const webSpeechDiagnostics = webSpeechMode ? getWebSpeechRecognitionDiagnostics() : null;
    if (webSpeechMode && !webSpeechSupported) {
      pushDiagnosticEvent(
        "audio",
        "Web Speech unsupported in this runtime",
        [
          `runtime=${webSpeechDiagnostics?.runtime ?? "unknown"}`,
          `constructor=${webSpeechDiagnostics?.constructorName ?? "missing"}`,
          `reason=${webSpeechDiagnostics?.reason ?? "constructor-missing"}`,
          `secure=${webSpeechDiagnostics?.secureContext == null ? "unknown" : webSpeechDiagnostics.secureContext}`,
        ].join(" · "),
      );
      setNotice({ key: "message.webSpeechUnsupported" });
      return;
    }
    const attempt = ++captureAttempt.current;
    capturePhase.current = "starting";
    // Do not let a tagged stage from the superseded session paint while the
    // replacement's native start_capture is still resolving.
    activeCaptureGeneration.current = null;
    pipelineDropNoticeShown.current = false;
    pipelineDropNoticeAccepted.current = null;
    clearPipelineDrops();
    if (webSpeechMode) {
      // Permission queries never prompt and must not be awaited here: the
      // recognition start below has to stay in the button's transient gesture.
      void queryWebSpeechRecognitionPermission().then((permission) => {
        pushDiagnosticEvent("audio", "Web Speech microphone permission", permission);
      });
    }
    captionIdleGuard.current = false;
    captionFailureMessage.current = null;
    const microphone = new MicrophoneCapture();
    const previousMicrophone = capture.current;
    const previousWebSpeech = webSpeechStream.current;
    capture.current = microphone;
    webSpeechStream.current = null;
    previousWebSpeech?.cancel();
    setNotice(null);
    clearInputLevelDb();
    clearCaptionDisplayTiming();
    clearCaptionMergeDiagnostics();
    setStatus((current) => ({ ...current, status: "starting", lastError: null }));
    pushDiagnosticEvent(
      "audio",
      "Capture starting",
      `device=${captureConfig.audio.inputDeviceId} · chunk=${captureConfig.audio.chunkMs}ms`,
    );
    let streamForAttempt: ParapperRecognitionStream | null = null;
    let outputQueueForAttempt: ParapperOutputQueue<ParapperRecognitionOutput> | null = null;
    let webSpeechForAttempt: WebSpeechRecognitionStream | null = null;
    // Web Speech can produce a result while the shared native runtime is still
    // starting. Keep the newest result per slot until startCapture resolves so
    // the first caption is published against a ready backend.
    let webSpeechBackendReady = !webSpeechMode;
    // Native start_capture returns the generation that owns this attempt. Keep
    // it on every queued Parapper/Web Speech payload so delayed invokes cannot
    // adopt a replacement session's generation at dequeue time.
    let captureGenerationForAttempt: number | undefined;
    const bufferedWebSpeechResults = new Map<number, WebSpeechRecognitionResult>();

    const publishWebSpeechResultNow = (result: WebSpeechRecognitionResult): void => {
      // Keep the engine's whitespace between Latin words while using a
      // trimmed value only for the empty-result guard and final caption.
      const rawTranscript = result.transcript;
      const transcript = rawTranscript.trim();
      if (!transcript || attempt !== captureAttempt.current) {
        return;
      }
      const startedAt = webSpeechStartedAt.current || Date.now();
      const id = webSpeechCaptionId.current ?? `web-speech:${attempt}:${startedAt}`;
      webSpeechCaptionId.current = id;
      webSpeechResults.current.set(result.resultIndex, rawTranscript);
      const sourceText = [...webSpeechResults.current.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, text]) => text)
        .join("")
        .trim();
      if (!sourceText) {
        return;
      }
      const receivedAt = Date.now();
      const caption: CaptionPayload = {
        id,
        sourceText,
        translationText: "",
        sourceLanguage: captureConfig.language.source,
        targetLanguage: captureConfig.language.target,
        startedAt,
        receivedAt,
        stage: "source",
        sequence: 0,
        isFinal: result.isFinal,
        confidence: result.confidence,
        captureGeneration: captureGenerationForAttempt,
      };
      pushPipelineStageEvent({
        stage: "asr",
        utteranceId: id,
        modelId: "web-speech",
        inputSnippet: "",
        outputText: sourceText,
        startedAt,
        at: receivedAt,
        durationMs: Math.max(0, receivedAt - startedAt),
        ok: true,
        error: null,
      });
      mergeAndCommitCaption(caption);
      markCaptureFirstCaption({
        captureGeneration: caption.captureGeneration ?? captureGenerationForAttempt ?? null,
        captionId: caption.id,
      });
      captionFailureMessage.current = null;
      setNotice(clearLegacyFailureNotice);
      setStatus((current) => (current.lastError ? { ...current, lastError: null } : current));
      webSpeechPublishChain.current = webSpeechPublishChain.current.then(async () => {
        if (attempt !== captureAttempt.current) {
          return;
        }
        try {
          await bridge.publishSourceCaption(caption);
        } catch (firstError: unknown) {
          // Native startup can race the first renderer caption even after
          // its promise resolves. Retry once on the next microtask while the
          // attempt is still current; the bounded chain never grows without
          // limit and stopCapture drains it before invalidation.
          if (attempt !== captureAttempt.current) {
            return;
          }
          await Promise.resolve();
          try {
            await bridge.publishSourceCaption(caption);
          } catch (retryError: unknown) {
            pushDiagnosticEvent(
              "error",
              "Web Speech caption publish failed",
              formatBridgeError(retryError ?? firstError) ?? String(retryError ?? firstError),
            );
          }
        }
      });
    };

    const publishWebSpeechResult = (result: WebSpeechRecognitionResult): void => {
      if (attempt !== captureAttempt.current) {
        return;
      }
      if (!webSpeechBackendReady) {
        bufferedWebSpeechResults.set(result.resultIndex, result);
        while (bufferedWebSpeechResults.size > MAX_BUFFERED_WEB_SPEECH_RESULTS) {
          const oldest = bufferedWebSpeechResults.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          bufferedWebSpeechResults.delete(oldest);
        }
        return;
      }
      publishWebSpeechResultNow(result);
    };

    const handleWebSpeechEvent = (event: WebSpeechRecognitionStreamEvent): void => {
      if (attempt !== captureAttempt.current) {
        return;
      }
      if (event.type === "start") {
        webSpeechStartedAt.current = Date.now();
        if (!webSpeechCaptionId.current) {
          webSpeechCaptionId.current = `web-speech:${attempt}:${webSpeechStartedAt.current}`;
        }
        pushDiagnosticEvent("audio", "Web Speech stream started");
        return;
      }
      if (event.type === "end") {
        pushDiagnosticEvent("audio", "Web Speech stream ended", `restart=${event.willRestart}`);
        // Keep the final result slots until stopCapture drains the publish
        // chain. Some WebKit builds dispatch `onend` before the last queued
        // `onresult` callback; clearing here would lose that final caption.
        // Automatic restarts begin a fresh recognition session and can safely
        // reset the aggregate immediately.
        if (event.willRestart) {
          webSpeechResults.current.clear();
          webSpeechCaptionId.current = null;
          webSpeechStartedAt.current = 0;
        }
        return;
      }
      if (event.type === "error") {
        pushDiagnosticEvent(
          event.error.fatal ? "error" : "audio",
          event.error.fatal ? "Web Speech stream failed" : "Web Speech stream warning",
          `${event.error.code} · ${event.error.message}`,
        );
        if (event.error.fatal) {
          const fallback =
            event.error.code === "not-allowed"
              ? "message.microphonePermissionDenied"
              : event.error.code === "service-not-allowed" ||
                  event.error.code === "language-not-supported"
                ? "message.webSpeechUnsupported"
                : "message.audioProcessingFailed";
          const nextNotice = noticeFromError(event.error, fallback);
          setNotice(nextNotice);
          captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
          setStatus((current) => ({
            ...current,
            status: "error",
            lastError: nextNotice.detail ?? t(nextNotice.key),
          }));
          void stopCapture();
        }
        return;
      }
      if (event.type === "partial" || event.type === "final") {
        publishWebSpeechResult(event);
      }
    };

    try {
      // Kick AudioContext construction / resume while the click gesture is
      // still warm. Keep this inside the startup guard: createAudioContext can
      // throw synchronously in a restricted host and must not strand the
      // lifecycle in `starting`.
      if (!webSpeechMode) {
        microphone.primeAudioContext();
      }
      // Web Speech requires a user-gesture-adjacent start in Safari/WKWebView.
      // Start it before the asynchronous native-service preparation below.
      if (webSpeechMode) {
        webSpeechForAttempt = new WebSpeechRecognitionStream({
          language: webSpeechLanguage(captureConfig.language.source),
          onEvent: handleWebSpeechEvent,
        });
        webSpeechStream.current = webSpeechForAttempt;
        webSpeechForAttempt.start();
      }
      // WKWebView silently rejects getUserMedia with NotAllowedError (no OS
      // dialog) once this click turn awaits. Open the new mic now, before any
      // await, so the permission prompt can appear. Stopping the previous
      // session may briefly overlap on the same device; prepareInput already
      // ladders constraints when the first open fails.
      const preparePromise = webSpeechMode
        ? null
        : microphone.prepareInput(captureConfig.audio.inputDeviceId, {
            noiseSuppression: captureConfig.audio.noiseSuppression !== false,
            autoGainControl: captureConfig.audio.autoGainControl !== false,
          });
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

      // Web Speech owns the microphone through the browser's recognition
      // service. Do not open a second getUserMedia/AudioContext graph or start
      // the Parapper PCM stream for this mode. Native start_capture still
      // marks the shared runtime as active so source captions can use the same
      // overlay/replay command path.
      if (webSpeechMode) {
        const backendStart = bridge.startCapture();
        backendStartPromise.current = backendStart;
        try {
          captureGenerationForAttempt = await backendStart;
        } finally {
          if (backendStartPromise.current === backendStart) {
            backendStartPromise.current = null;
          }
        }
        if (attempt !== captureAttempt.current) {
          webSpeechForAttempt?.cancel();
          bufferedWebSpeechResults.clear();
          return;
        }
        webSpeechBackendReady = true;
        activeCaptureGeneration.current = captureGenerationForAttempt ?? null;
        const bufferedResults = [...bufferedWebSpeechResults.values()].sort(
          (left, right) => left.resultIndex - right.resultIndex,
        );
        bufferedWebSpeechResults.clear();
        for (const result of bufferedResults) {
          publishWebSpeechResultNow(result);
        }
        capturePhase.current = "capturing";
        setStatus((current) => ({ ...current, status: "capturing", lastError: null }));
        pushDiagnosticEvent("audio", "Web Speech capture active");
        return;
      }

      // Mic open already started above (gesture-safe). Overlap the remainder
      // with backend readiness so a cold gateway does not delay the first chunk.
      const backendPromise = bridge.startCapture();
      backendStartPromise.current = backendPromise;
      const [prepareResult, backendResult] = await Promise.allSettled([
        preparePromise ?? Promise.resolve(),
        backendPromise,
      ]);
      if (backendStartPromise.current === backendPromise) {
        backendStartPromise.current = null;
      }
      if (attempt !== captureAttempt.current) {
        // The stop that invalidated this attempt owns backend teardown.  Do
        // not issue a second stop here: a replacement attempt may already
        // have started by the time these parallel preparations settle.
        await microphone.stop().catch(() => undefined);
        return;
      }
      if (backendResult.status === "rejected") {
        await microphone.stop().catch(() => undefined);
        throw backendResult.reason;
      }
      captureGenerationForAttempt = backendResult.value;
      activeCaptureGeneration.current = captureGenerationForAttempt ?? null;
      if (prepareResult.status === "rejected") {
        await bridge.stopCapture().catch(() => undefined);
        throw prepareResult.reason;
      }

      const desktopStreaming = bridge.isDesktop() && !webSpeechMode;
      chunkProcessor.current?.reset();
      clearChunkTimingStats();
      parapperOutputQueue.current?.close();
      parapperOutputQueue.current = null;

      // Correlate prepare → ready → first PCM → first caption under the native
      // capture generation so cold-start speech loss is greppable in exports.
      beginCaptureStartupCorrelation({
        captureGeneration: captureGenerationForAttempt ?? null,
        mode: recognitionMode,
      });

      if (desktopStreaming) {
        // Mic is open but Parapper session.ready (ASR preload) has not resolved
        // yet. Buffer a bounded PCM preroll so speech during that gap is not
        // discarded; start() flushes it once before live sendPcm16 frames.
        try {
          await microphone.beginPrerollCapture();
        } catch (error) {
          pushDiagnosticEvent(
            "audio",
            "Preroll capture unavailable",
            formatBridgeError(error) ?? String(error),
          );
        }
        if (attempt !== captureAttempt.current) {
          recordCaptureStartupDiscard("superseded-generation", {
            captureGeneration: captureGenerationForAttempt ?? null,
            source: "audio",
          });
          await microphone.stop().catch(() => undefined);
          return;
        }

        const noteFirstCaption = (caption: CaptionPayload): void => {
          if (!caption.sourceText.trim()) {
            return;
          }
          markCaptureFirstCaption({
            captureGeneration: caption.captureGeneration ?? captureGenerationForAttempt ?? null,
            captionId: caption.id,
          });
        };

        const processOutput = async (output: ParapperRecognitionOutput): Promise<void> => {
          if (attempt !== captureAttempt.current) {
            return;
          }
          if (parapperRawMode) {
            const rawText = selectParapperSurfaceText(output);
            if (!rawText) {
              return;
            }
            const receivedAt = Date.now();
            const startedAt = Math.max(0, receivedAt - Math.max(0, output.elapsedMs));
            const rawCaption: CaptionPayload = {
              id: `parapper:${output.sessionId}:${output.turnSessionId}:${output.turnId}`,
              sourceText: rawText,
              translationText: "",
              sourceLanguage: captureConfig.language.source,
              targetLanguage: captureConfig.language.target,
              startedAt,
              receivedAt,
              stage: "source",
              sequence: 0,
              isFinal: output.isFinal,
              captureGeneration: captureGenerationForAttempt,
            };
            pushPipelineStageEvent({
              stage: "asr",
              utteranceId: rawCaption.id,
              modelId: output.sourceAsrModel || captureConfig.models.asr,
              inputSnippet: rawText,
              outputText: rawText,
              startedAt,
              at: receivedAt,
              durationMs: Math.max(0, output.elapsedMs),
              ok: true,
              error: null,
            });
            mergeAndCommitCaption(rawCaption);
            noteFirstCaption(rawCaption);
            captionFailureMessage.current = null;
            setNotice(clearLegacyFailureNotice);
            setStatus((current) => (current.lastError ? { ...current, lastError: null } : current));
            pushDiagnosticEvent(
              "caption",
              output.isFinal ? "Parapper raw final" : "Parapper raw interim",
              `id=${rawCaption.id} · src=${rawText.slice(0, 48)}`,
            );
            webSpeechPublishChain.current = webSpeechPublishChain.current
              .then(() => bridge.publishSourceCaption(rawCaption))
              .catch((error: unknown) => {
                pushDiagnosticEvent(
                  "error",
                  "Parapper raw caption publish failed",
                  formatBridgeError(error) ?? String(error),
                );
              });
            return;
          }
          const startedAt =
            typeof performance !== "undefined" && typeof performance.now === "function"
              ? performance.now()
              : Date.now();
          try {
            // Paint again in case this item was drained after a long wait; the
            // enqueue path already painted the latest partial immediately.
            const provisional = buildParapperProvisionalCaption(output, {
              sourceLanguage: captureConfig.language.source,
              targetLanguage: captureConfig.language.target,
            });
            if (provisional) {
              mergeAndCommitCaption(provisional);
              noteFirstCaption(provisional);
            }
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
              showNoSpeechNotice();
              return;
            }
            pushDiagnosticEvent(
              "audio",
              output.isFinal ? "Parapper final normalized" : "Parapper interim normalized",
              `id=${nextCaption.id} · ${elapsed}ms · src=${nextCaption.sourceText.slice(0, 48)}`,
            );
            mergeAndCommitCaption(nextCaption);
            noteFirstCaption(nextCaption);
            captionFailureMessage.current = null;
            setNotice(clearLegacyFailureNotice);
            setStatus((current) => (current.lastError ? { ...current, lastError: null } : current));
          } catch (error: unknown) {
            if (attempt !== captureAttempt.current) {
              return;
            }
            if (!shouldToastAudioProcessingFailure(error)) {
              const detail = formatBridgeError(error);
              pushDiagnosticEvent("audio", "No speech (soft-skip)", detail);
              showNoSpeechNotice();
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
        const handleParapperEvent = (event: ParapperStreamEvent): void => {
          if (attempt !== captureAttempt.current || event.type === "speech.started") {
            if (event.type === "speech.started" && attempt === captureAttempt.current) {
              pushDiagnosticEvent("audio", "Parapper speech started");
              markCaptureFirstSpeech({
                captureGeneration: captureGenerationForAttempt ?? null,
              });
            }
            return;
          }
          const output: ParapperRecognitionOutput = {
            text: event.text,
            sourceText: event.sourceText,
            azookeyInputText: event.azookeyInputText,
            sessionId: event.sessionId,
            turnSessionId: event.turnSessionId,
            turnId: event.turnId,
            revision: event.revision,
            outputSequence: event.outputSequence,
            segmentId: event.segmentId,
            previousSegmentId: event.previousSegmentId,
            sourceAsrModel: event.sourceAsrModel,
            sourceLanguage: event.sourceLanguage,
            detectedLanguage: event.detectedLanguage,
            elapsedMs: event.elapsedMs,
            audioDurationMs: event.audioDurationMs,
            isFinal: event.type === "turn.final",
            captureGeneration: captureGenerationForAttempt,
            asrLatency: event.asrLatency,
          };
          markCaptionIpcReceived(
            `parapper:${event.sessionId}:${event.turnSessionId}:${event.turnId}`,
            {
              turnId: event.turnId,
              turnSessionId: event.turnSessionId,
              asrLatency: event.asrLatency,
            },
          );
          // Paint before enqueue so recognized characters appear while an older
          // revision is still awaiting AzooKey. The queue serializes normalize,
          // but Live/Syphon must not wait on that serial chain.
          const provisional = buildParapperProvisionalCaption(output, {
            sourceLanguage: captureConfig.language.source,
            targetLanguage: captureConfig.language.target,
          });
          if (provisional) {
            mergeAndCommitCaption(provisional);
            noteFirstCaption(provisional);
          }
          parapperOutputQueue.current?.enqueue(output);
        };
        const outputQueue = createParapperOutputQueue<ParapperRecognitionOutput>(processOutput);
        outputQueueForAttempt = outputQueue;
        parapperOutputQueue.current = outputQueue;
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
        // Publish the local stream before awaiting session.ready so a Stop
        // pressed during startup can cancel the connecting socket as well.
        parapperStream.current = streamForAttempt;
        // Start and await the transport before wiring microphone.start().  The
        // PCM callback throws when the socket is not ready; starting both in
        // parallel would turn a normal session-ready race into a fatal track
        // error and leave an orphaned WebSocket on failure.
        try {
          await streamForAttempt.start();
        } catch (error) {
          pushDiagnosticEvent(
            "error",
            "Parapper stream start failed",
            formatBridgeError(error) ?? String(error),
          );
          throw error;
        }
        // stream.start() resolves after session.ready / ASR preload completes.
        markCaptureSessionReady({
          captureGeneration: captureGenerationForAttempt ?? null,
        });
        if (attempt !== captureAttempt.current) {
          recordCaptureStartupDiscard("superseded-generation", {
            captureGeneration: captureGenerationForAttempt ?? null,
            source: "audio",
          });
          streamForAttempt.cancel();
          await microphone.stop().catch(() => undefined);
          return;
        }
      } else {
        // Browser preview keeps the historical HTTP demo path. The native
        // desktop path above is the only path that talks to a real Parapper
        // sidecar, so it can preserve the continuous state machine.
        const processorRef: { current: LatestWinsProcessor<AudioChunk> | null } = { current: null };
        const transcribeTimeoutMs = resolveTranscribeAudioChunkTimeoutMs(
          captureConfig.endpoint.timeoutMs,
        );
        const reportTranscriptionFailure = (
          error: unknown,
          late = false,
          flightCurrent = true,
        ): void => {
          const detail = formatBridgeError(error) ?? String(error);
          const current = attempt === captureAttempt.current && flightCurrent;
          if (late || !current) {
            // A first-caption race deliberately lets the queue move on while
            // the native invoke finishes in the background.  Always observe a
            // later rejection, but never repaint an error over a replacement
            // session's caption.
            pushDiagnosticEvent("error", "Late ASR invoke failed", detail);
            return;
          }
          if (!shouldToastAudioProcessingFailure(error)) {
            pushDiagnosticEvent("audio", "No speech (soft-skip)", detail);
            showNoSpeechNotice();
            return;
          }
          const nextNotice = noticeFromError(error, "message.audioProcessingFailed");
          pushDiagnosticEvent(
            "error",
            "Audio processing failed",
            nextNotice.detail ?? nextNotice.key,
          );
          setNotice(nextNotice);
          captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
          setStatus((currentStatus) => ({
            ...currentStatus,
            lastError: nextNotice.detail ?? t(nextNotice.key),
          }));
        };
        const processor = createLatestWinsProcessor<AudioChunk>({
          isActive: () => attempt === captureAttempt.current,
          onStatsChange: (stats) => setChunkTimingStats(stats),
          process: async (chunk, { whenFirstCaption, isCurrent }) => {
            const invokePromise = (async (): Promise<void> => {
              const nextCaption = await withFiniteTimeout(
                bridge.transcribeAudioChunk(chunk),
                transcribeTimeoutMs,
                "transcribe_audio_chunk timed out",
                (error) => reportTranscriptionFailure(error, true),
              );
              if (attempt !== captureAttempt.current || !isCurrent()) return;
              if (!nextCaption.sourceText.trim()) {
                showNoSpeechNotice();
                return;
              }
              processorRef.current?.markFirstCaption();
              mergeAndCommitCaption(nextCaption);
              markCaptureFirstCaption({
                captureGeneration:
                  nextCaption.captureGeneration ?? captureGenerationForAttempt ?? null,
                captionId: nextCaption.id,
              });
              captionFailureMessage.current = null;
              setNotice(clearLegacyFailureNotice);
              setStatus((current) =>
                current.lastError ? { ...current, lastError: null } : current,
              );
            })();
            // Keep an explicit rejection observer attached before racing
            // against first paint.  This is the important part of latest-wins:
            // a slow ASR rejection still reaches diagnostics after process()
            // returned and must never become an unhandled promise rejection.
            const observedInvoke = invokePromise.catch((error: unknown) => {
              reportTranscriptionFailure(error, false, isCurrent());
            });
            await Promise.race([whenFirstCaption(), observedInvoke]);
          },
        });
        processorRef.current = processor;
        chunkProcessor.current = processor;
      }

      // Snapshot preroll before start() flushes the ring into streamPcmHandler.
      const prerollSampleCount = microphone.getPrerollSampleCount();
      const prerollFrameCount = microphone.getPrerollFrameCount();
      if (prerollSampleCount > 0 || prerollFrameCount > 0) {
        markCapturePrerollStats(
          {
            prerollFrameCount,
            prerollSampleCount,
            prerollDurationMs: Math.round((prerollSampleCount / TARGET_SAMPLE_RATE) * 1_000),
          },
          { captureGeneration: captureGenerationForAttempt ?? null },
        );
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
        {
          noiseSuppression: captureConfig.audio.noiseSuppression !== false,
          autoGainControl: captureConfig.audio.autoGainControl !== false,
        },
        {
          adaptiveGate:
            resolveSilenceGateMode(captureConfig.audio.adaptiveNoiseFloor) === "adaptive",
          streamPcmHandler: streamForAttempt
            ? (frame) => {
                markCaptureFirstForwardedPcm({
                  captureGeneration: captureGenerationForAttempt ?? null,
                });
                streamForAttempt?.sendPcm16(frame);
              }
            : undefined,
        },
      );
      if (attempt !== captureAttempt.current) {
        // A newer lifecycle owns the bridge now; only release this attempt's
        // microphone.  Stopping the shared backend here could tear down the
        // replacement session after a slow microphone.start() continuation.
        recordCaptureStartupDiscard("superseded-generation", {
          captureGeneration: captureGenerationForAttempt ?? null,
          source: "audio",
        });
        await microphone.stop().catch(() => undefined);
        return;
      }
      capturePhase.current = "capturing";
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
      webSpeechForAttempt?.cancel();
      bufferedWebSpeechResults.clear();
      if (outputQueueForAttempt && parapperOutputQueue.current === outputQueueForAttempt) {
        outputQueueForAttempt.close();
        parapperOutputQueue.current = null;
      }
      if (streamForAttempt && parapperStream.current === streamForAttempt) {
        parapperStream.current = null;
      }
      if (webSpeechStream.current === webSpeechForAttempt) {
        webSpeechStream.current = null;
      }
      await microphone.stop().catch(() => undefined);
      if (attempt !== captureAttempt.current) {
        recordCaptureStartupDiscard("superseded-generation", {
          captureGeneration: captureGenerationForAttempt ?? null,
          source: "audio",
        });
        return;
      }
      recordCaptureStartupDiscard("start-failed", {
        captureGeneration: captureGenerationForAttempt ?? null,
        source: "runtime",
      });
      // This attempt still owns the backend only when its generation remains
      // current.  A stop/restart may have taken ownership while microphone
      // cleanup was awaiting; never stop that replacement bridge session.
      await bridge.stopCapture().catch(() => undefined);
      capturePhase.current = "idle";
      captionIdleGuard.current = true;
      activeCaptureGeneration.current = null;
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

  const stopCaptureImpl = async (): Promise<void> => {
    if (capturePhase.current === "stopping") {
      return;
    }
    const wasStarting = capturePhase.current === "starting";
    capturePhase.current = "stopping";
    // Keep the current attempt valid through microphone.stop(). AudioCapture
    // flushes a speech-aware partial tail from its pending buffer, and the
    // handler must still be allowed to enqueue that tail into the processor.
    // Invalidating/resetting first silently drops the final sub-window.
    const stoppingAttempt = captureAttempt.current;
    const microphone = capture.current;
    const processor = chunkProcessor.current;
    const stream = parapperStream.current;
    const speech = webSpeechStream.current;
    const outputQueue = parapperOutputQueue.current;
    const backendStart = backendStartPromise.current;
    clearInputLevelDb();
    pushDiagnosticEvent("audio", "Capture stopping");

    if (wasStarting) {
      // A start can be suspended in prepareInput(), stream.start(), or
      // microphone.start(). Invalidate it before awaiting teardown so none of
      // those continuations can publish a capturing status or stop a newer
      // bridge session. There is no user-visible capture tail to drain yet.
      const cancelledGeneration = activeCaptureGeneration.current;
      captureAttempt.current += 1;
      captionIdleGuard.current = true;
      activeCaptureGeneration.current = null;
      recordCaptureStartupDiscard("cancelled-during-start", {
        captureGeneration: cancelledGeneration,
        source: "audio",
      });
      processor?.reset();
      if (chunkProcessor.current === processor) {
        chunkProcessor.current = null;
      }
      clearChunkTimingStats();
      clearCaptionDisplayTiming();
      parapperOutputQueue.current?.close();
      parapperOutputQueue.current = null;
      parapperStream.current?.cancel();
      parapperStream.current = null;
      webSpeechStream.current?.cancel();
      webSpeechStream.current = null;
      webSpeechResults.current.clear();
      webSpeechCaptionId.current = null;
      webSpeechStartedAt.current = 0;
      try {
        await webSpeechPublishChain.current;
      } catch (error) {
        pushDiagnosticEvent(
          "error",
          "Web Speech caption drain failed",
          formatBridgeError(error) ?? String(error),
        );
      }
      await microphone.stop().catch(() => undefined);
      try {
        // Ensure a start_capture command that was already dispatched cannot
        // complete after the stop command and resurrect the native session.
        await backendStart;
      } catch {
        // The start failure is owned by startCapture; teardown still proceeds.
      }
      // The invalidated start owns the bridge only until a replacement starts;
      // check the generation after mic cleanup before issuing stop_capture.
      if (captureAttempt.current !== stoppingAttempt + 1) {
        return;
      }
      await bridge.stopCapture().catch(() => undefined);
      capturePhase.current = "idle";
      clearCaptionState();
      setStatus((current) => ({ ...current, status: "idle", lastError: null }));
      if (capture.current === microphone) {
        capture.current = new MicrophoneCapture();
      }
      return;
    }
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
        // Capture the queue belonging to this attempt. A replacement capture
        // may install a new queue while the old socket is draining; waiting on
        // the ref in that case would stall the new session's stop path.
        await outputQueue?.whenIdle();
      } catch (error) {
        microphoneFailure ??= error;
        captionFailureMessage.current = formatBridgeError(error) ?? "Parapper output drain failed";
      }
      outputQueue?.close();
      if (parapperOutputQueue.current === outputQueue) {
        parapperOutputQueue.current = null;
      }
      if (parapperStream.current === stream) {
        parapperStream.current = null;
      }
    }
    if (speech) {
      // Ask the browser for a graceful stop so any final result generated for
      // the current utterance is delivered before the session closes. The
      // stream disables auto-restart before calling stop(); the explicit
      // cleanup below still handles engines that never emit onend.
      speech.stop();
      try {
        // Final Web Speech results are delivered before the browser's onend in
        // compliant engines. Drain publishes already queued by those results
        // before invalidating this capture attempt.
        await Promise.resolve();
        await webSpeechPublishChain.current;
      } catch (error) {
        microphoneFailure ??= error;
        captionFailureMessage.current =
          formatBridgeError(error) ?? "Web Speech caption drain failed";
      }
      if (webSpeechStream.current === speech) {
        webSpeechStream.current = null;
      }
      webSpeechResults.current.clear();
      webSpeechCaptionId.current = null;
      webSpeechStartedAt.current = 0;
    }
    if (!speech) {
      try {
        await webSpeechPublishChain.current;
      } catch (error) {
        microphoneFailure ??= error;
        captionFailureMessage.current =
          formatBridgeError(error) ?? "source caption publish drain failed";
      }
    }
    if (captureAttempt.current !== stoppingAttempt) {
      return;
    }

    // Invalidate late invoke completions/events only after the queue drained.
    captureAttempt.current += 1;
    captionIdleGuard.current = true;
    activeCaptureGeneration.current = null;
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
    capturePhase.current = "idle";
    if (!failure) {
      pushDiagnosticEvent("audio", "Capture stopped");
      const retainedFailure = captionFailureMessage.current;
      if (retainedFailure) {
        // A successful microphone/backend teardown does not erase evidence of
        // an earlier ASR/translation failure. Keep the caption and surface the
        // error while transitioning to idle; the session is over, so pending
        // cross-id translations must not leak into the next capture.
        clearCaptionMergeDiagnostics();
        setStatus((current) => ({ ...current, status: "idle", lastError: retainedFailure }));
      } else {
        clearCaptionState();
        setStatus((current) => ({ ...current, status: "idle", lastError: null }));
      }
    } else {
      const nextNotice = noticeFromError(failure, "message.microphoneStopFailed");
      captionFailureMessage.current = nextNotice.detail ?? t(nextNotice.key);
      pushDiagnosticEvent("error", "Capture stop failed", nextNotice.detail ?? nextNotice.key);
      // The session ended in failure; drop pending cross-id translations so a
      // retry cannot recover an entry from this aborted session.
      clearCaptionMergeDiagnostics();
      setNotice(nextNotice);
      setStatus((current) => ({
        ...current,
        status: "error",
        lastError: nextNotice.detail ?? t(nextNotice.key),
      }));
    }
  };

  const stopCapture = (): Promise<void> => {
    const existing = stopPromise.current;
    if (existing) {
      return existing;
    }
    const next = stopCaptureImpl();
    stopPromise.current = next;
    void next
      .finally(() => {
        if (stopPromise.current === next) {
          stopPromise.current = null;
        }
      })
      .catch(() => undefined);
    return next;
  };

  // Keep restart-coordinator hooks pointed at the latest closures each render.
  startCaptureRef.current = startCapture;
  stopCaptureRef.current = stopCapture;

  const openTransparentCapture = async () => {
    try {
      await bridge.openTransparentCapture();
      setTransparentCaptureOpen(true);
      pushDiagnosticEvent(
        "overlay",
        "Transparent capture shown",
        `${config.overlay.width}×${config.overlay.height}`,
      );
    } catch (error) {
      const notice = noticeFromError(error, "message.transparentOpenFailed");
      pushDiagnosticEvent("error", "Transparent capture open failed", notice.detail ?? notice.key);
      setNotice(notice);
    }
  };

  const openStyleEditor = async () => {
    try {
      await bridge.openStyleEditorWindow();
      pushDiagnosticEvent("overlay", "Style editor window opened");
    } catch (error) {
      const notice = noticeFromError(error, "message.styleEditorOpenFailed");
      pushDiagnosticEvent("error", "Style editor open failed", notice.detail ?? notice.key);
      setNotice(notice);
    }
  };

  const closeTransparentCapture = async () => {
    try {
      await bridge.closeTransparentCapture();
      setTransparentCaptureOpen(false);
      pushDiagnosticEvent("overlay", "Transparent capture hidden");
    } catch (error) {
      const notice = noticeFromError(error, "message.transparentOpenFailed");
      pushDiagnosticEvent("error", "Transparent capture hide failed", notice.detail ?? notice.key);
      setNotice(notice);
    }
  };

  const toggleCapture = () => {
    if (
      status.status === "capturing" ||
      status.status === "starting" ||
      capturePhase.current === "capturing" ||
      capturePhase.current === "starting" ||
      captureRestartRef.current.isBusy()
    ) {
      // Explicit user stop cancels a pending restart so a coalesced start does
      // not resurrect capture after the toggle to idle.
      captureRestartRef.current.cancelPending();
      void stopCapture();
      return;
    }
    if (!canStartCaptionCapture(startBlockReason)) {
      pushDiagnosticEvent(
        "audio",
        "Capture start blocked",
        `reason=${startBlockReason ?? "unknown"}`,
      );
      return;
    }
    void startCapture(config);
  };

  const captureSessionActive =
    status.status === "capturing" ||
    status.status === "starting" ||
    capturePhase.current === "capturing" ||
    capturePhase.current === "starting" ||
    // Mid-restart the UI may briefly show idle between stop and start; keep
    // coalescing so the newest device/config is not dropped on the floor.
    captureRestartRef.current.isBusy();

  const handleDeviceChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = {
      ...config,
      audio: { ...config.audio, inputDeviceId: event.target.value },
    };
    setConfig(next);
    if (captureSessionActive) {
      captureRestartRef.current.requestRestart(next);
    }
  };

  const handleConfigChange = (nextConfig: AppConfig) => {
    const captureChanged = captureConfigRequiresRestart(config, nextConfig);
    const rescoreChanged =
      config.rescore.enabled !== nextConfig.rescore.enabled ||
      config.rescore.modelPath !== nextConfig.rescore.modelPath ||
      config.rescore.lmWeight !== nextConfig.rescore.lmWeight ||
      config.rescore.confusionWeight !== nextConfig.rescore.confusionWeight ||
      config.rescore.overcorrectionMargin !== nextConfig.rescore.overcorrectionMargin ||
      config.rescore.timeoutMs !== nextConfig.rescore.timeoutMs;
    const nativeOutputChanged =
      (config.overlay.nativeOutputEnabled ?? false) !==
      (nextConfig.overlay.nativeOutputEnabled ?? false);
    setConfig(nextConfig);
    // Recognition mode, device, chunking, and gate settings change microphone
    // or stream ownership. Restart an active/starting session immediately so a
    // setting cannot appear to succeed while the existing graph keeps values
    // from the previous config. Latest-wins coalescing owns the stop→start
    // sequence so rapid changes cannot attach multiple start callbacks.
    if (captureChanged && captureSessionActive) {
      captureRestartRef.current.requestRestart(nextConfig);
    } else if (rescoreChanged) {
      // Input-LM correction toggle/weights apply on the next caption via
      // save_config → invalidate_rescorer; no mic restart required.
      void persistConfigLive(nextConfig, "Rescore settings applied live");
    } else if (nativeOutputChanged) {
      // Syphon/Spout2 start/stop is owned by save_config's NativeOutputHandle
      // replacement. Persist immediately so the checkbox matches runtime status
      // without requiring a separate Save click.
      void persistConfigLive(nextConfig, "Native output setting applied live");
    }
  };

  const noticeText = resolveLiveNoticeText(notice, status.lastError, t);

  return (
    <div className={`app-shell${activeTab === "live" ? " app-shell--live" : ""}`}>
      <header className="topbar">
        <div className="topbar-start">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <img className="brand-mark-image" src="/app-icon.png" alt="" width={39} height={39} />
            </div>
            <div className="brand-name">Kotoba Beacon</div>
          </div>
          <nav className="nav-tabs" aria-label={t("sidebar.menu")}>
            <button
              className={activeTab === "live" ? "active" : ""}
              type="button"
              data-testid="nav-live"
              aria-current={activeTab === "live" ? "page" : undefined}
              onClick={() => setActiveTab("live")}
            >
              {t("sidebar.live")}
            </button>
            <button
              className={activeTab === "settings" ? "active" : ""}
              type="button"
              data-testid="nav-settings"
              aria-current={activeTab === "settings" ? "page" : undefined}
              onClick={() => setActiveTab("settings")}
            >
              {t("sidebar.settings")}
            </button>
          </nav>
        </div>
        <div className="topbar-meta">
          <LocaleSwitcher />
          <span className={`runtime-pill ${status.status}`}>
            <i />
            {t(statusKeys[status.status])}
          </span>
        </div>
      </header>
      <div className="workspace">
        <main className="content">
          {activeTab === "live" ? (
            <LiveView
              config={config}
              status={status}
              caption={progressiveCaption}
              devices={devices}
              message={noticeText}
              transparentCaptureOpen={transparentCaptureOpen}
              startBlockReason={startBlockReason}
              onToggleCapture={toggleCapture}
              onDeviceChange={handleDeviceChange}
              onRefreshDevices={() => void refreshDevices({ primePermission: true })}
              onCloseMessage={() => setNotice(null)}
              onOpenTransparentCapture={() => void openTransparentCapture()}
              onCloseTransparentCapture={() => void closeTransparentCapture()}
              onOpenStyleEditor={() => void openStyleEditor()}
            />
          ) : (
            <SettingsView
              config={config}
              models={models}
              devices={devices}
              saving={saving}
              desktopStreaming={bridge.isDesktop()}
              captureStarting={
                status.status === "starting" ||
                capturePhase.current === "starting" ||
                captureRestartRef.current.isBusy()
              }
              onConfigChange={handleConfigChange}
              onModelChange={setModel}
              onDeviceChange={handleDeviceChange}
              onRefreshDevices={() => void refreshDevices({ primePermission: true })}
              onSave={() => void save()}
              onOpenTransparentCapture={() => void openTransparentCapture()}
              onCloseTransparentCapture={() => void closeTransparentCapture()}
            />
          )}
        </main>
      </div>
      {status.nativeOutput === "syphon" || status.nativeOutput === "spout2" ? (
        <NativeFramePublisher config={config} caption={progressiveCaption} />
      ) : null}
    </div>
  );
};
