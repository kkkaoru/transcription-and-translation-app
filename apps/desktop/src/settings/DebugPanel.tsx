import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type AudioCaptureDiagnostics,
  enumerateAudioInputDevices,
  getLastAudioCaptureDiagnostics,
} from "../core/audio";
import { bridge, formatBridgeError } from "../core/bridge";
import { type ChunkTimingStats, getChunkTimingStats } from "../core/chunkQueue";
import { DEFAULT_RECOGNITION_MODE, isRecognitionMode, mergeConfig } from "../core/defaults";
import {
  getDiagnosticEvents,
  getDiagnosticStoreRevision,
  subscribeDiagnosticEvents,
} from "../core/diagnostics";
import {
  getCaptionDisplayTimingRevision,
  getCaptionDisplayTimingStats,
  subscribeCaptionDisplayTiming,
} from "../core/display-timing";
import { type PipelineDropSnapshot, snapshotPipelineDrops } from "../core/dropDiagnostics";
import {
  clearPipelineStageEvents,
  getLatestPipelineStageByName,
  getPipelineStageEvents,
  getPipelineStageStoreRevision,
  getUtteranceStageGroups,
  hydratePipelineStageEvents,
  isVerbosePipelineLogging,
  readDebugPanelOpenPreference,
  relativeStageOffsetMs,
  setVerbosePipelineLogging,
  stageDisplayLabel,
  subscribePipelineStages,
  writeDebugPanelOpenPreference,
} from "../core/pipelineStages";
import {
  appendStructuredLog,
  clearStructuredLogs,
  downloadStructuredLogs,
  formatLogsAsJsonl,
  getLogLevel,
  getStructuredLogRevision,
  getStructuredLogs,
  LOG_LEVELS,
  redactSensitiveText,
  type StructuredLogRecord,
  setLogLevel,
  subscribeStructuredLogs,
} from "../core/structuredLog";
import type {
  AudioInputDevice,
  LogLevel,
  ModelStatusEntry,
  PipelineStageEvent,
  PipelineStageName,
  RecognitionMode,
  SidecarStatus,
  UpdateStatus,
} from "../core/types";
import { useI18n } from "../i18n/I18nProvider";

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown, fallback = "—"): string => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
};

const pick = (record: JsonObject | null | undefined, key: string): unknown =>
  record ? record[key] : undefined;

const collectFrontendDiagnostics = (): JsonObject => {
  const audioSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    (typeof window.AudioContext === "function" ||
      typeof (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext === "function");

  return {
    runtime: bridge.isDesktop() ? "tauri" : "browser",
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    language: typeof navigator !== "undefined" ? navigator.language : "unknown",
    languages: typeof navigator !== "undefined" ? [...(navigator.languages ?? [])] : [],
    online: typeof navigator !== "undefined" ? navigator.onLine : null,
    viewport: {
      width: typeof window !== "undefined" ? window.innerWidth : null,
      height: typeof window !== "undefined" ? window.innerHeight : null,
      devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : null,
    },
    audio: {
      mediaDevices: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices),
      getUserMedia:
        typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
      audioContext: audioSupported,
    },
    // Keep the route useful for support while dropping query/fragment credentials
    // and userinfo from a copied/exported diagnostics snapshot.
    href: typeof window !== "undefined" ? safeEndpointLabel(window.location.href) : null,
    collectedAt: new Date().toISOString(),
  };
};

const formatEventTime = (iso: string, locale: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
};

const deviceLabel = (
  device: AudioInputDevice,
  t: ReturnType<typeof useI18n>["t"],
  index: number,
): string => {
  const label = device.label.trim();
  if (label) {
    return label;
  }
  if (device.deviceId === "default" || !device.deviceId) {
    return t("debug.defaultDevice");
  }
  return t("audio.fallbackDevice", { number: index + 1 });
};

const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
};

const modelInstallLabel = (status: string, t: ReturnType<typeof useI18n>["t"]): string => {
  switch (status) {
    case "ready":
      return t("debug.modelReady");
    case "missing":
      return t("debug.modelMissing");
    case "partial":
      return t("debug.modelPartial");
    case "corrupt":
      return t("debug.modelCorrupt");
    case "downloading":
      return t("debug.modelDownloading");
    case "error":
      return t("debug.modelError");
    default:
      return status || t("debug.modelStatusUnknown");
  }
};

const recognitionModeLabel = (
  mode: RecognitionMode,
  t: ReturnType<typeof useI18n>["t"],
): string => {
  switch (mode) {
    case "parapper-raw":
      return t("debug.recognitionModeParapperRaw");
    case "web-speech":
      return t("debug.recognitionModeWebSpeech");
    case "parapper-azookey":
      return t("debug.recognitionModeParapperAzookey");
  }
};

const recognitionModeDescription = (
  mode: RecognitionMode,
  t: ReturnType<typeof useI18n>["t"],
): string => {
  switch (mode) {
    case "parapper-raw":
      return t("debug.recognitionModeParapperRawDescription");
    case "web-speech":
      return t("debug.recognitionModeWebSpeechDescription");
    case "parapper-azookey":
      return t("debug.recognitionModeParapperAzookeyDescription");
  }
};

const pipelineDropSourceLabel = (source: string, t: ReturnType<typeof useI18n>["t"]): string => {
  switch (source) {
    case "audio":
      return t("debug.pipelineDropAudio");
    case "chunk-queue":
      return t("debug.pipelineDropChunkQueue");
    case "parapper-output-queue":
      return t("debug.pipelineDropParapperQueue");
    case "translation":
      return t("debug.pipelineDropTranslation");
    default:
      return source;
  }
};

const STAGE_NAMES: PipelineStageName[] = ["asr", "normalize", "translate"];

/** Keep the common drop producers visible even when their current count is zero. */
const PIPELINE_DROP_SOURCE_ORDER = [
  "audio",
  "chunk-queue",
  "parapper-output-queue",
  "translation",
] as const;

const DEFAULT_TEST_CAPTION = "これはデバッグ用のテスト字幕です。";

const formatMs = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }
  return `${Math.round(value)} ms`;
};

const formatStageAt = (at: number, locale: string): string => {
  if (!Number.isFinite(at) || at <= 0) {
    return "—";
  }
  // Backend emits epoch millis; accept seconds as a fallback.
  const ms = at < 1_000_000_000_000 ? at * 1000 : at;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return String(at);
  }
  // Include milliseconds so short stages still show distinct start/end.
  const clock = new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${clock}.${millis}`;
};

const formatRelativeOffset = (offsetMs: number): string => {
  if (!Number.isFinite(offsetMs) || offsetMs <= 0) {
    return "t+0 ms";
  }
  return `t+${Math.round(offsetMs)} ms`;
};

const stageTimingSummary = (event: PipelineStageEvent, locale: string): string => {
  const start = formatStageAt(event.startedAt, locale);
  const end = formatStageAt(event.at, locale);
  return `${start} → ${end} · ${formatMs(event.durationMs)}`;
};

const formatStructuredLogLine = (entry: StructuredLogRecord): string => {
  const parts = [
    entry.at,
    entry.level.toUpperCase(),
    entry.source,
    entry.stage ? `stage=${entry.stage}` : null,
    entry.chunkId ? `chunk=${entry.chunkId}` : null,
    entry.message,
    entry.durationMs != null ? `durationMs=${entry.durationMs}` : null,
    entry.inputBytes != null ? `inBytes=${entry.inputBytes}` : null,
    entry.outputBytes != null ? `outBytes=${entry.outputBytes}` : null,
    entry.error ? `error=${entry.error}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
};

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

const toNullableString = (value: unknown): string | null => {
  if (value == null || value === "") {
    return null;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : null;
};

const toNullableNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;

const normalizeRetiredCount = (value: unknown): number | null => {
  const direct = toNullableNumber(value);
  if (direct != null) {
    return direct;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const key of ["count", "total", "retired"]) {
    const nested = toNullableNumber(pick(value, key));
    if (nested != null) {
      return nested;
    }
  }
  return null;
};

const readTranslationRetired = (backend: JsonObject | null): number | null => {
  const runtime = pick(backend, "runtimeStatus");
  return normalizeRetiredCount(
    pick(backend, "translationRetired") ??
      pick(backend, "translation_retired") ??
      pick(isRecord(runtime) ? runtime : null, "translationRetired"),
  );
};

const readParapperOutputSuperseded = (backend: JsonObject | null): number | null => {
  const runtime = pick(backend, "runtimeStatus");
  return normalizeRetiredCount(
    pick(backend, "parapperOutputSuperseded") ??
      pick(backend, "parapper_output_superseded") ??
      pick(isRecord(runtime) ? runtime : null, "parapperOutputSuperseded"),
  );
};

const readSourceCaptionStaleDropped = (backend: JsonObject | null): number | null => {
  const runtime = pick(backend, "runtimeStatus");
  return normalizeRetiredCount(
    pick(backend, "sourceCaptionStaleDropped") ??
      pick(backend, "source_caption_stale_dropped") ??
      pick(isRecord(runtime) ? runtime : null, "sourceCaptionStaleDropped"),
  );
};

const readUnfencedCaptionAccepted = (backend: JsonObject | null): number | null => {
  const runtime = pick(backend, "runtimeStatus");
  return normalizeRetiredCount(
    pick(backend, "unfencedCaptionAccepted") ??
      pick(backend, "unfenced_caption_accepted") ??
      pick(isRecord(runtime) ? runtime : null, "unfencedCaptionAccepted"),
  );
};

const normalizeUpdateStatus = (value: unknown): UpdateStatus => {
  if (!isRecord(value)) {
    return { ...DEFAULT_UPDATE_STATUS };
  }
  const metadataValue = pick(value, "metadata");
  const metadata = isRecord(metadataValue)
    ? {
        version: redactSensitiveText(asString(pick(metadataValue, "version"), "—")) ?? "—",
        date: redactSensitiveText(toNullableString(pick(metadataValue, "date"))),
        body: redactSensitiveText(toNullableString(pick(metadataValue, "body"))),
        target: redactSensitiveText(toNullableString(pick(metadataValue, "target"))),
        source: (() => {
          const source = toNullableString(pick(metadataValue, "source"));
          return source ? safeEndpointLabel(source) : null;
        })(),
        channel: redactSensitiveText(toNullableString(pick(metadataValue, "channel"))),
      }
    : null;
  return {
    status: asString(pick(value, "status"), "unknown"),
    currentVersion: toNullableString(pick(value, "currentVersion")),
    availableVersion: toNullableString(pick(value, "availableVersion")),
    checkedAt: toNullableString(pick(value, "checkedAt")),
    downloadedBytes: toNullableNumber(pick(value, "downloadedBytes")),
    totalBytes: toNullableNumber(pick(value, "totalBytes")),
    error: redactSensitiveText(toNullableString(pick(value, "error"))),
    source: (() => {
      const source = toNullableString(pick(value, "source"));
      return source ? safeEndpointLabel(source) : null;
    })(),
    channel: toNullableString(pick(value, "channel")),
    switchResult: redactSensitiveText(
      toNullableString(pick(value, "switchResult") ?? pick(value, "relaunchResult")),
    ),
    relaunchDeferred: pick(value, "relaunchDeferred") === true,
    metadata,
  };
};

const normalizeSidecars = (value: unknown): SidecarStatus[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry) => ({
    id: asString(pick(entry, "id"), "sidecar"),
    kind: asString(pick(entry, "kind"), "runtime"),
    version: toNullableString(pick(entry, "version")),
    versionSource: toNullableString(pick(entry, "versionSource")),
    health: asString(pick(entry, "health") ?? pick(entry, "status"), "unknown"),
    healthUrl: (() => {
      const healthUrl = toNullableString(pick(entry, "healthUrl") ?? pick(entry, "url"));
      return healthUrl ? safeEndpointLabel(healthUrl) : null;
    })(),
    port: toNullableNumber(pick(entry, "port")),
    active: pick(entry, "active") === true,
    lastError: redactSensitiveText(
      toNullableString(pick(entry, "lastError") ?? pick(entry, "error")),
    ),
    startedAt: toNullableString(pick(entry, "startedAt")),
    switchResult: redactSensitiveText(
      toNullableString(pick(entry, "switchResult") ?? pick(entry, "switch")),
    ),
  }));
};

/** Normalize fulfilled IPC arrays before they reach render-time `.map()` calls. */
const normalizeAudioDevices = (value: unknown): AudioInputDevice[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry, index) => ({
    deviceId: toNullableString(pick(entry, "deviceId")) ?? `device-${index + 1}`,
    label: toNullableString(pick(entry, "label")) ?? "",
    groupId: toNullableString(pick(entry, "groupId")) ?? "",
  }));
};

const normalizeModelStatus = (value: unknown): ModelStatusEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((entry, index) => ({
    modelId: toNullableString(pick(entry, "modelId")) ?? `model-${index + 1}`,
    status: toNullableString(pick(entry, "status")) ?? "unknown",
    installedBytes: toNullableNumber(pick(entry, "installedBytes")),
    expectedBytes: toNullableNumber(pick(entry, "expectedBytes")) ?? 0,
    lastError: redactSensitiveText(
      toNullableString(pick(entry, "lastError") ?? pick(entry, "error")),
    ),
    sourceUrl: toNullableString(pick(entry, "sourceUrl")),
    localPath: toNullableString(pick(entry, "localPath")),
    role: toNullableString(pick(entry, "role")),
    label: toNullableString(pick(entry, "label")),
  }));
};

const formatUpdateBytes = (status: UpdateStatus): string | null => {
  if (status.downloadedBytes == null && status.totalBytes == null) {
    return null;
  }
  return `${formatBytes(status.downloadedBytes)} / ${formatBytes(status.totalBytes)}`;
};

const safeEndpointLabel = (value: string | null): string => {
  if (!value) {
    return "—";
  }
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] || "—";
  }
};

const SENSITIVE_DIAGNOSTIC_KEY =
  /(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|authorization|password|passwd|secret|private[-_]?key|client[-_]?secret|cookie|session[-_]?token|signature|^sig$)/i;

const sanitizeDiagnosticValue = (value: unknown, key = ""): unknown => {
  if (SENSITIVE_DIAGNOSTIC_KEY.test(key)) {
    return value == null ? null : "[REDACTED]";
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDiagnosticValue(entry, key));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeDiagnosticValue(childValue, childKey),
      ]),
    );
  }
  return value;
};

/** Keep refresh/action failures visible without allowing malformed IPC errors
 * to break the panel render or leak credential-shaped text. */
const recordDebugOperationError = (operation: string, reason: unknown): string => {
  let formatted: string | undefined;
  try {
    formatted =
      typeof formatBridgeError === "function"
        ? formatBridgeError(reason)
        : (toNullableString(reason) ?? undefined);
  } catch {
    formatted = undefined;
  }
  let detail: string;
  try {
    detail = redactSensitiveText(formatted) ?? `Unable to ${operation}.`;
  } catch {
    detail = `Unable to ${operation}.`;
  }
  try {
    appendStructuredLog({
      level: "error",
      source: "frontend",
      message: `debug ${operation} failed`,
      error: detail,
      fields: { operation },
    });
  } catch {
    // Error reporting is best-effort; the panel must still render the fallback.
  }
  return detail;
};

export function DebugPanel() {
  const { locale, t } = useI18n();
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Persist open so developers can leave debug mode expanded across reloads.
  const [open, setOpen] = useState(() => readDebugPanelOpenPreference());
  const [backendInfo, setBackendInfo] = useState<JsonObject | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [switchResult, setSwitchResult] = useState<string | null>(null);
  const [sidecars, setSidecars] = useState<SidecarStatus[]>([]);
  const [frontendInfo, setFrontendInfo] = useState<JsonObject | null>(null);
  const [captureInfo, setCaptureInfo] = useState<AudioCaptureDiagnostics | null>(null);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatusEntry[]>([]);
  const [recognitionMode, setRecognitionMode] = useState<RecognitionMode>(DEFAULT_RECOGNITION_MODE);
  const [testCaptionText, setTestCaptionText] = useState(DEFAULT_TEST_CAPTION);
  const [testCaptionRunning, setTestCaptionRunning] = useState(false);
  const [testCaptionNotice, setTestCaptionNotice] = useState<string | null>(null);
  const [testCaptionError, setTestCaptionError] = useState<string | null>(null);
  const [pipelineDrops, setPipelineDrops] = useState<PipelineDropSnapshot>(() =>
    snapshotPipelineDrops(),
  );
  // The panel is mounted in both Live and Settings routes. Avoid rerendering
  // its large diagnostics tree for every caption while collapsed; opening the
  // panel resubscribes and useSyncExternalStore reconciles the latest snapshot.
  const subscribeDiagnosticsWhenOpen = useCallback(
    (listener: () => void) => (open ? subscribeDiagnosticEvents(listener) : () => undefined),
    [open],
  );
  const diagnosticStoreRevision = useSyncExternalStore(
    subscribeDiagnosticsWhenOpen,
    getDiagnosticStoreRevision,
    getDiagnosticStoreRevision,
  );
  const events = useMemo(() => {
    void diagnosticStoreRevision;
    return getDiagnosticEvents();
  }, [diagnosticStoreRevision]);
  const subscribeStagesWhenOpen = useCallback(
    (listener: () => void) => (open ? subscribePipelineStages(listener) : () => undefined),
    [open],
  );
  // Snapshot is a scalar revision; derived arrays are memoized from it.
  const stageStoreRevision = useSyncExternalStore(
    subscribeStagesWhenOpen,
    getPipelineStageStoreRevision,
    getPipelineStageStoreRevision,
  );
  // stageStoreRevision is the external-store snapshot; re-read on each change.
  const stageEvents = useMemo(() => {
    void stageStoreRevision;
    return getPipelineStageEvents();
  }, [stageStoreRevision]);
  const subscribeDisplayTimingWhenOpen = useCallback(
    (listener: () => void) => (open ? subscribeCaptionDisplayTiming(listener) : () => undefined),
    [open],
  );
  const displayTimingRevision = useSyncExternalStore(
    subscribeDisplayTimingWhenOpen,
    getCaptionDisplayTimingRevision,
    getCaptionDisplayTimingRevision,
  );
  const displayTiming = useMemo(() => {
    void displayTimingRevision;
    return getCaptionDisplayTimingStats();
  }, [displayTimingRevision]);
  const utteranceGroups = useMemo(() => {
    void stageStoreRevision;
    return getUtteranceStageGroups();
  }, [stageStoreRevision]);
  const verboseLogging = useMemo(() => {
    void stageStoreRevision;
    return isVerbosePipelineLogging();
  }, [stageStoreRevision]);
  const subscribeStructuredLogsWhenOpen = useCallback(
    (listener: () => void) => (open ? subscribeStructuredLogs(listener) : () => undefined),
    [open],
  );
  const structuredLogRevision = useSyncExternalStore(
    subscribeStructuredLogsWhenOpen,
    getStructuredLogRevision,
    getStructuredLogRevision,
  );
  const logLevel = useMemo(() => {
    void structuredLogRevision;
    return getLogLevel();
  }, [structuredLogRevision]);
  const structuredLogs = useMemo(() => {
    void structuredLogRevision;
    return getStructuredLogs({ maxLevel: getLogLevel(), limit: 80 });
  }, [structuredLogRevision]);
  const [chunkTiming, setChunkTiming] = useState<ChunkTimingStats>(() => getChunkTimingStats());
  const [loading, setLoading] = useState(false);
  // Distinguish the initial open fetch from the panel's data availability.
  // A failed native call leaves backendInfo null; using that as the only
  // sentinel would make the open effect retry forever and starve the panel.
  const [initialFetchAttempted, setInitialFetchAttempted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingVerbose, setSavingVerbose] = useState(false);
  const [savingLogLevel, setSavingLogLevel] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [updateAction, setUpdateAction] = useState<"check" | "install" | "relaunch" | null>(null);

  // Convert optional updater fields to flat rows once. Keeping the conditional
  // logic here makes the rendered panel a shallow list and prevents status
  // details from becoming a deeply nested block of JSX.
  const updateRows: Array<{
    label: string;
    value: string;
    testId?: string;
    error?: boolean;
  }> = [];
  if (updateStatus) {
    updateRows.push(
      { label: t("debug.updateState"), value: updateStatus.status, testId: "debug-update-state" },
      {
        label: t("debug.updateVersion"),
        value: `${asString(updateStatus.currentVersion, "—")} → ${asString(updateStatus.availableVersion, "—")}`,
      },
      { label: t("debug.updateSource"), value: safeEndpointLabel(updateStatus.source) },
    );
    if (updateStatus.checkedAt) {
      updateRows.push({ label: t("debug.updateCheckedAt"), value: updateStatus.checkedAt });
    }
    const progress = formatUpdateBytes(updateStatus);
    if (progress) {
      updateRows.push({ label: t("debug.updateProgress"), value: progress });
    }
    if (updateStatus.error) {
      updateRows.push({ label: t("debug.updateError"), value: updateStatus.error, error: true });
    }
    const effectiveSwitchResult = switchResult ?? updateStatus.switchResult;
    if (effectiveSwitchResult) {
      updateRows.push({ label: t("debug.switchResult"), value: effectiveSwitchResult });
    }
  }

  const sidecarRows = sidecars.map((sidecar) => ({
    id: sidecar.id,
    label: `${sidecar.id} · ${sidecar.health}${sidecar.active ? ` · ${t("debug.sidecarActive")}` : ""}`,
    detail: [
      `${t("debug.sidecarVersion")}: ${asString(sidecar.version, "—")}`,
      sidecar.port != null ? `port=${sidecar.port}` : null,
      sidecar.healthUrl ? safeEndpointLabel(sidecar.healthUrl) : null,
      sidecar.switchResult ? `${t("debug.switchResult")}: ${sidecar.switchResult}` : null,
      sidecar.lastError ? `${t("debug.lastError")}: ${sidecar.lastError}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  }));

  const combined = useMemo(() => {
    if (
      !backendInfo &&
      !frontendInfo &&
      !captureInfo &&
      devices.length === 0 &&
      modelStatus.length === 0 &&
      events.length === 0 &&
      stageEvents.length === 0 &&
      pipelineDrops.total === 0 &&
      structuredLogs.length === 0 &&
      !updateStatus &&
      sidecars.length === 0
    ) {
      return null;
    }
    return {
      frontend: frontendInfo,
      backend: backendInfo,
      audioCapture: captureInfo,
      recognitionMode,
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        groupId: device.groupId,
      })),
      modelDownloads: modelStatus,
      recentEvents: events,
      pipelineStages: stageEvents,
      utteranceGroups,
      displayTiming,
      chunkTiming,
      pipelineDrops,
      translationRetired: readTranslationRetired(backendInfo),
      parapperOutputSuperseded: readParapperOutputSuperseded(backendInfo),
      sourceCaptionStaleDropped: readSourceCaptionStaleDropped(backendInfo),
      unfencedCaptionAccepted: readUnfencedCaptionAccepted(backendInfo),
      verbosePipelineLogging: verboseLogging,
      logLevel,
      structuredLogs,
      runtimeDiagnostics: {
        update: updateStatus,
        sidecars,
        switchResult,
      },
    };
  }, [
    backendInfo,
    frontendInfo,
    captureInfo,
    recognitionMode,
    devices,
    modelStatus,
    events,
    stageEvents,
    utteranceGroups,
    displayTiming,
    chunkTiming,
    pipelineDrops,
    verboseLogging,
    logLevel,
    structuredLogs,
    updateStatus,
    sidecars,
    switchResult,
  ]);

  const fetchInfo = useCallback(async () => {
    setInitialFetchAttempted(true);
    setLoading(true);
    setError(null);
    try {
      const nextFrontend = collectFrontendDiagnostics();
      const nextCapture = getLastAudioCaptureDiagnostics();
      setFrontendInfo(nextFrontend);
      setCaptureInfo(nextCapture);
      setChunkTiming(getChunkTimingStats());
      setPipelineDrops(snapshotPipelineDrops());
      const [infoResult, devicesResult, modelStatusResult, updateResult, configResult] =
        await Promise.allSettled([
          bridge.getDebugInfo(),
          enumerateAudioInputDevices(),
          bridge.listModelStatus(),
          typeof bridge.getUpdateStatus === "function"
            ? bridge.getUpdateStatus()
            : Promise.resolve(null),
          typeof bridge.getConfig === "function" ? bridge.getConfig() : Promise.resolve(null),
        ]);
      if (!mountedRef.current) {
        return;
      }
      let backend: JsonObject | null = null;
      if (infoResult.status === "fulfilled") {
        const rawBackend = isRecord(infoResult.value)
          ? infoResult.value
          : { value: infoResult.value };
        const backendValue = sanitizeDiagnosticValue(rawBackend);
        backend = isRecord(backendValue) ? backendValue : { value: backendValue };
        setBackendInfo(backend);

        // Recover stage rows emitted before the app-wide event listener or
        // DebugPanel mounted. Hydration is deduplicated and does not replay
        // historical diagnostics into the live feed.
        const stageHistory =
          pick(backend, "pipelineStages") ??
          pick(backend, "pipelineStageHistory") ??
          pick(backend, "stageHistory");
        if (Array.isArray(stageHistory)) {
          hydratePipelineStageEvents(stageHistory);
        }
      } else {
        setBackendInfo(null);
        setError(recordDebugOperationError("refresh", infoResult.reason));
      }

      const configResultValue =
        configResult.status === "fulfilled" && isRecord(configResult.value)
          ? configResult.value
          : null;
      const backendConfigValue = backend ? pick(backend, "config") : undefined;
      const backendConfig = isRecord(backendConfigValue) ? backendConfigValue : null;
      const modeCandidates = [
        pick(configResultValue, "recognitionMode"),
        pick(backendConfig, "recognitionMode"),
        pick(backend, "recognitionMode"),
      ];
      for (const candidate of modeCandidates) {
        if (isRecognitionMode(candidate)) {
          setRecognitionMode(candidate);
          break;
        }
      }

      if (devicesResult.status === "fulfilled") {
        setDevices(normalizeAudioDevices(devicesResult.value));
      } else {
        setDevices([]);
        setError(recordDebugOperationError("audio devices", devicesResult.reason));
      }
      if (modelStatusResult.status === "fulfilled") {
        setModelStatus(normalizeModelStatus(modelStatusResult.value));
      } else {
        setModelStatus([]);
        setError(recordDebugOperationError("model status", modelStatusResult.reason));
      }

      const nativeUpdate = updateResult.status === "fulfilled" ? updateResult.value : null;
      if (updateResult.status === "rejected") {
        setError(recordDebugOperationError("update status", updateResult.reason));
      }
      const backendUpdate = backend
        ? (pick(backend, "update") ?? pick(backend, "updateStatus"))
        : undefined;
      setUpdateStatus(
        nativeUpdate
          ? normalizeUpdateStatus(nativeUpdate)
          : isRecord(backendUpdate)
            ? normalizeUpdateStatus(backendUpdate)
            : null,
      );
      const backendSwitch = backend
        ? (pick(backend, "switchResult") ??
          pick(backend, "relaunchResult") ??
          pick(backend, "runtimeSwitch"))
        : undefined;
      setSwitchResult(
        toNullableString(
          isRecord(backendSwitch)
            ? (pick(backendSwitch, "reason") ?? pick(backendSwitch, "result"))
            : backendSwitch,
        ),
      );
      setSidecars(normalizeSidecars(backend ? pick(backend, "sidecars") : null));

      // Desktop: prefer persisted Rust config so verbose matches backend logs.
      // Browser preview has no writable backend config — keep localStorage preference.
      if (bridge.isDesktop() && backend) {
        const config = backendConfig;
        const debugValue = pick(config, "debug") ?? pick(backend, "debug");
        const debug = isRecord(debugValue) ? debugValue : null;
        const verboseFromBackend = pick(debug, "verboseLogging");
        if (typeof verboseFromBackend === "boolean") {
          setVerbosePipelineLogging(verboseFromBackend);
        }
        const levelFromBackend = pick(debug, "logLevel");
        if (typeof levelFromBackend === "string") {
          setLogLevel(levelFromBackend);
        }
      }
    } catch (e) {
      // Keep already-collected frontend/stage data visible even when a
      // malformed native payload throws during normalization.
      if (mountedRef.current) {
        setError(recordDebugOperationError("refresh", e));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (open && !initialFetchAttempted && !loading) {
      void fetchInfo();
    }
  }, [open, initialFetchAttempted, loading, fetchInfo]);

  const publishTestCaption = useCallback(async () => {
    const sourceText = testCaptionText.trim();
    if (!sourceText) {
      setTestCaptionNotice(null);
      setTestCaptionError(t("debug.testCaptionRequired"));
      return;
    }
    setTestCaptionRunning(true);
    setTestCaptionNotice(null);
    setTestCaptionError(null);
    const now = Date.now();
    const id = `debug-test-${now}`;
    try {
      if (typeof bridge.publishSourceCaption !== "function") {
        throw new Error("publish_source_caption is unavailable in this app build");
      }
      await bridge.publishSourceCaption({
        id,
        sourceText,
        translationText: "",
        sourceLanguage: "ja",
        targetLanguage: "en",
        startedAt: now,
        receivedAt: now,
        stage: "source",
        sequence: 0,
        isFinal: true,
      });
      if (!mountedRef.current) {
        return;
      }
      appendStructuredLog({
        level: "info",
        source: "frontend",
        stage: "source",
        chunkId: id,
        message: "debug test caption published",
        fields: {
          recognitionMode,
          sourceChars: sourceText.length,
        },
      });
      setTestCaptionNotice(t("debug.testCaptionSent"));
    } catch (reason) {
      if (mountedRef.current) {
        setTestCaptionError(recordDebugOperationError("publish test caption", reason));
      }
    } finally {
      if (mountedRef.current) {
        setTestCaptionRunning(false);
      }
    }
  }, [recognitionMode, t, testCaptionText]);

  // Chunk timing is published from the live capture path; poll snapshot while open.
  useEffect(() => {
    if (!open) {
      return;
    }
    setChunkTiming(getChunkTimingStats());
    setPipelineDrops(snapshotPipelineDrops());
    const timer = window.setInterval(() => {
      setChunkTiming(getChunkTimingStats());
      setPipelineDrops(snapshotPipelineDrops());
    }, 500);
    return () => {
      window.clearInterval(timer);
    };
  }, [open]);

  // Native updater transitions are pushed independently of refreshes. Keep a
  // local snapshot for the panel and mirror only safe, metadata-only fields to
  // the frontend structured log ring buffer.
  useEffect(() => {
    if (!open || typeof bridge.listenUpdateStatus !== "function") {
      return;
    }
    let disposed = false;
    let pending: ReturnType<typeof bridge.listenUpdateStatus>;
    try {
      pending = Promise.resolve(
        bridge.listenUpdateStatus((next) => {
          if (disposed) {
            return;
          }
          const status = normalizeUpdateStatus(next);
          setUpdateStatus(status);
          if (status.switchResult) {
            setSwitchResult(status.switchResult);
          }
          appendStructuredLog({
            level: status.status === "failed" ? "error" : "info",
            source: "backend",
            message: `updater status: ${status.status}`,
            error: status.error,
            fields: {
              currentVersion: status.currentVersion,
              availableVersion: status.availableVersion,
              source: status.source,
              channel: status.channel,
              downloadedBytes: status.downloadedBytes,
              totalBytes: status.totalBytes,
              switchResult: status.switchResult ?? null,
            },
          });
        }),
      ) as ReturnType<typeof bridge.listenUpdateStatus>;
    } catch (reason) {
      setError(recordDebugOperationError("subscribe updater status", reason));
      return;
    }
    void pending.catch((reason) => {
      if (!disposed) {
        setError(recordDebugOperationError("subscribe updater status", reason));
      }
    });
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten?.()).catch(() => undefined);
    };
  }, [open]);

  useEffect(() => {
    if (!open || typeof bridge.listenUpdateRelaunchDeferred !== "function") {
      return;
    }
    let disposed = false;
    let pending: ReturnType<typeof bridge.listenUpdateRelaunchDeferred>;
    try {
      pending = Promise.resolve(
        bridge.listenUpdateRelaunchDeferred((reason) => {
          if (disposed) {
            return;
          }
          const safeReason = toNullableString(reason) ?? "unknown";
          setSwitchResult(safeReason);
          appendStructuredLog({
            level: "info",
            source: "backend",
            message: "updated app switch deferred",
            fields: { reason: safeReason },
          });
        }),
      ) as ReturnType<typeof bridge.listenUpdateRelaunchDeferred>;
    } catch (reason) {
      setError(recordDebugOperationError("subscribe update switch", reason));
      return;
    }
    void pending.catch((reason) => {
      if (!disposed) {
        setError(recordDebugOperationError("subscribe update switch", reason));
      }
    });
    return () => {
      disposed = true;
      void pending.then((unlisten) => unlisten?.()).catch(() => undefined);
    };
  }, [open]);

  const toggleVerboseLogging = useCallback(async (enabled: boolean) => {
    setVerbosePipelineLogging(enabled);
    if (!bridge.isDesktop()) {
      return;
    }
    setSavingVerbose(true);
    try {
      const current = await bridge.getConfig();
      const next = mergeConfig({
        ...current,
        debug: { ...current.debug, verboseLogging: enabled, logLevel: getLogLevel() },
      });
      await bridge.saveConfig(next);
    } catch (e) {
      if (mountedRef.current) {
        setError(recordDebugOperationError("save verbose logging", e));
      }
    } finally {
      if (mountedRef.current) {
        setSavingVerbose(false);
      }
    }
  }, []);

  const changeLogLevel = useCallback(async (level: LogLevel) => {
    setLogLevel(level);
    if (!bridge.isDesktop()) {
      return;
    }
    setSavingLogLevel(true);
    try {
      const current = await bridge.getConfig();
      const next = mergeConfig({
        ...current,
        debug: {
          ...current.debug,
          verboseLogging: isVerbosePipelineLogging(),
          logLevel: level,
        },
      });
      await bridge.saveConfig(next);
    } catch (e) {
      if (mountedRef.current) {
        setError(recordDebugOperationError("save log level", e));
      }
    } finally {
      if (mountedRef.current) {
        setSavingLogLevel(false);
      }
    }
  }, []);

  const checkForUpdate = useCallback(async () => {
    if (typeof bridge.checkForUpdate !== "function") {
      return;
    }
    setUpdateAction("check");
    setError(null);
    try {
      const metadata = await bridge.checkForUpdate();
      if (!mountedRef.current) {
        return;
      }
      const next =
        typeof bridge.getUpdateStatus === "function"
          ? await bridge.getUpdateStatus()
          : metadata
            ? {
                ...DEFAULT_UPDATE_STATUS,
                status: "available",
                availableVersion: metadata.version,
                metadata,
              }
            : { ...DEFAULT_UPDATE_STATUS, status: "idle" };
      const normalized = normalizeUpdateStatus(next);
      setUpdateStatus(normalized);
      if (normalized.switchResult) {
        setSwitchResult(normalized.switchResult);
      }
    } catch (e) {
      if (!mountedRef.current) {
        return;
      }
      const detail = recordDebugOperationError("updater check", e);
      setUpdateStatus((previous) => ({
        ...(previous ?? DEFAULT_UPDATE_STATUS),
        status: "failed",
        error: detail,
      }));
      setError(detail);
    } finally {
      if (mountedRef.current) {
        setUpdateAction(null);
      }
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (typeof bridge.installUpdate !== "function") {
      return;
    }
    setUpdateAction("install");
    setError(null);
    try {
      await bridge.installUpdate();
      if (!mountedRef.current) {
        return;
      }
      const next =
        typeof bridge.getUpdateStatus === "function" ? await bridge.getUpdateStatus() : null;
      if (next) {
        const normalized = normalizeUpdateStatus(next);
        setUpdateStatus(normalized);
        if (normalized.switchResult) {
          setSwitchResult(normalized.switchResult);
        }
      }
    } catch (e) {
      if (!mountedRef.current) {
        return;
      }
      const detail = recordDebugOperationError("updater install", e);
      setUpdateStatus((previous) => ({
        ...(previous ?? DEFAULT_UPDATE_STATUS),
        status: "failed",
        error: detail,
      }));
      setError(detail);
    } finally {
      if (mountedRef.current) {
        setUpdateAction(null);
      }
    }
  }, []);

  const relaunchUpdatedApp = useCallback(async () => {
    if (typeof bridge.relaunchToUpdatedApp !== "function") {
      return;
    }
    setUpdateAction("relaunch");
    setError(null);
    try {
      const result = await bridge.relaunchToUpdatedApp();
      if (!mountedRef.current) {
        return;
      }
      const safeReason = isRecord(result)
        ? (toNullableString(pick(result, "reason")) ?? "unknown")
        : "unknown";
      const deferred = isRecord(result) && pick(result, "deferred") === true;
      setSwitchResult(safeReason);
      appendStructuredLog({
        level: "info",
        source: "backend",
        message: "updated app switch requested",
        fields: { deferred, reason: safeReason },
      });
      if (deferred) {
        setUpdateStatus((previous) => ({
          ...(previous ?? DEFAULT_UPDATE_STATUS),
          switchResult: safeReason,
          relaunchDeferred: true,
        }));
      }
    } catch (e) {
      if (!mountedRef.current) {
        return;
      }
      const detail = recordDebugOperationError("updated app switch", e);
      setSwitchResult("failed");
      setError(detail);
    } finally {
      if (mountedRef.current) {
        setUpdateAction(null);
      }
    }
  }, []);

  const exportLogsDownload = useCallback(
    (format: "json" | "jsonl") => {
      try {
        const name = downloadStructuredLogs(format, { maxLevel: getLogLevel() });
        setExportNotice(name ? `${t("debug.exportSaved")}: ${name}` : t("debug.exportSaved"));
        window.setTimeout(() => {
          if (mountedRef.current) {
            setExportNotice(null);
          }
        }, 4000);
      } catch (e) {
        setError(recordDebugOperationError(`export ${format}`, e));
      }
    },
    [t],
  );

  const exportLogsToDir = useCallback(async () => {
    try {
      const body = formatLogsAsJsonl(getStructuredLogs({ maxLevel: getLogLevel() }));
      const path = await bridge.exportDebugLogs(body, "jsonl");
      if (!mountedRef.current) {
        return;
      }
      // Also trigger a browser download so the user has a local copy in preview.
      downloadStructuredLogs("jsonl", { maxLevel: getLogLevel() });
      setExportNotice(`${t("debug.exportSaved")}: ${path}`);
      window.setTimeout(() => {
        if (mountedRef.current) {
          setExportNotice(null);
        }
      }, 5000);
    } catch (e) {
      if (mountedRef.current) {
        setError(recordDebugOperationError("export logs", e));
      }
    }
  }, [t]);

  const copyToClipboard = async () => {
    if (!combined) {
      return;
    }
    try {
      // The file export path runs sanitize_export_body natively; the clipboard
      // path must apply the same credential redaction to every string value.
      const redacted = JSON.stringify(
        combined,
        (_key, value: unknown) =>
          typeof value === "string" ? (redactSensitiveText(value) ?? value) : value,
        2,
      );
      await navigator.clipboard.writeText(redacted);
      if (!mountedRef.current) {
        return;
      }
      setCopied(true);
      setTimeout(() => {
        if (mountedRef.current) {
          setCopied(false);
        }
      }, 2000);
    } catch (e) {
      if (mountedRef.current) {
        setError(recordDebugOperationError("copy diagnostics", e));
      }
    }
  };

  const envValue = pick(backendInfo, "env");
  const env = isRecord(envValue) ? envValue : null;
  const runtimeValue = pick(backendInfo, "runtimeStatus");
  const runtimeStatus = isRecord(runtimeValue) ? runtimeValue : null;
  const modelSummaryValue = pick(backendInfo, "modelSummary");
  const modelSummary = isRecord(modelSummaryValue) ? modelSummaryValue : null;
  const servicesValue = pick(backendInfo, "services");
  const services = isRecord(servicesValue) ? servicesValue : null;
  const configValue = pick(backendInfo, "config");
  const config = isRecord(configValue) ? configValue : null;
  const audioConfigValue = pick(config, "audio");
  const audioConfig = isRecord(audioConfigValue) ? audioConfigValue : null;
  const overlayConfigValue = pick(config, "overlay");
  const overlayConfig = isRecord(overlayConfigValue) ? overlayConfigValue : null;
  const selectedDeviceId = asString(pick(audioConfig, "inputDeviceId"), "default");

  const modelDownloadErrors = modelStatus
    .map((entry) => entry.lastError?.trim())
    .filter((value): value is string => Boolean(value));

  const eventErrors = events
    .filter((event) => event.kind === "error")
    .slice(0, 6)
    .map((event) => [event.message, event.detail].filter(Boolean).join(" — "));

  const lastErrorCandidates = [
    asString(pick(backendInfo, "lastError"), ""),
    asString(pick(runtimeStatus, "lastError"), ""),
    asString(captureInfo?.lastError, ""),
    ...modelDownloadErrors,
    ...eventErrors,
  ]
    .map((value) => value.trim())
    .filter(Boolean);

  const lastError = lastErrorCandidates[0] ?? "";
  const recentErrors = [...new Set(lastErrorCandidates)].slice(0, 8);

  const serviceRows = services
    ? Object.entries(services).map(([name, value]) => {
        if (isRecord(value)) {
          const ok = pick(value, "ok") ?? pick(value, "reachable") ?? pick(value, "status");
          const detail =
            pick(value, "error") ??
            pick(value, "detail") ??
            pick(value, "url") ??
            pick(value, "address") ??
            "";
          return {
            name,
            detail: `${asString(ok, "?")}${detail ? ` · ${asString(detail)}` : ""}`,
          };
        }
        return { name, detail: asString(value) };
      })
    : [];

  const modelsValue = pick(backendInfo, "models");
  const modelRows = Array.isArray(modelsValue)
    ? modelsValue.filter(isRecord).map((model) => ({
        id: asString(pick(model, "id"), "model"),
        state: pick(model, "ready")
          ? t("debug.modelReady")
          : pick(model, "installed")
            ? t("debug.modelCorrupt")
            : t("debug.modelMissing"),
        path: asString(pick(model, "path")),
        bytes:
          pick(model, "installedBytes") != null
            ? `${asString(pick(model, "installedBytes"))} / ${asString(pick(model, "expectedBytes"))}`
            : asString(pick(model, "expectedBytes")),
      }))
    : [];

  const downloadReady = modelStatus.filter((entry) => entry.status === "ready").length;
  const downloadBusy = modelStatus.filter((entry) => entry.status === "downloading").length;

  const frontendAudioValue = pick(frontendInfo, "audio");
  const frontendAudio = isRecord(frontendAudioValue) ? frontendAudioValue : null;
  const frontendViewportValue = pick(frontendInfo, "viewport");
  const frontendViewport = isRecord(frontendViewportValue) ? frontendViewportValue : null;

  const nativeTranslationRetired = readTranslationRetired(backendInfo);
  const nativeParapperOutputSuperseded = readParapperOutputSuperseded(backendInfo);
  const nativeSourceCaptionStaleDropped = readSourceCaptionStaleDropped(backendInfo);
  const nativeUnfencedCaptionAccepted = readUnfencedCaptionAccepted(backendInfo);
  const pipelineDropSourceRows = [
    ...PIPELINE_DROP_SOURCE_ORDER.map((source) => ({
      source,
      count:
        source === "translation" && nativeTranslationRetired != null
          ? nativeTranslationRetired
          : (pipelineDrops.bySource[source] ?? 0),
    })),
    ...Object.entries(pipelineDrops.bySource)
      .filter(([source]) => !PIPELINE_DROP_SOURCE_ORDER.some((known) => known === source))
      .map(([source, count]) => ({ source, count })),
  ];
  const pipelineDropReasonRows = Object.entries(pipelineDrops.byReason);

  const setPanelOpen = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    writeDebugPanelOpenPreference(nextOpen);
  }, []);

  return (
    <section className="panel settings-section debug-panel" data-testid="debug-panel">
      <details
        open={open}
        onToggle={(event) => setPanelOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="debug-summary">
          <span className="debug-summary-title">{t("debug.title")}</span>
        </summary>
        <div className="debug-content">
          <p className="download-lead">{t("debug.lead")}</p>
          <p className="debug-inline-meta" data-testid="debug-enable-hint">
            {t("debug.enableHint")}
          </p>
          <div className="debug-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void fetchInfo()}
              disabled={loading}
            >
              {loading ? t("debug.loading") : t("debug.refresh")}
            </button>
            <button
              className="secondary-button"
              type="button"
              data-testid="debug-check-update"
              onClick={() => void checkForUpdate()}
              disabled={updateAction !== null || !bridge.isDesktop()}
            >
              {updateAction === "check" ? t("debug.updateChecking") : t("debug.updateCheck")}
            </button>
            <button
              className="secondary-button"
              type="button"
              data-testid="debug-install-update"
              onClick={() => void installUpdate()}
              disabled={
                updateAction !== null ||
                !bridge.isDesktop() ||
                !updateStatus ||
                !["available", "ready"].includes(updateStatus.status)
              }
            >
              {updateAction === "install" ? t("debug.updateInstalling") : t("debug.updateInstall")}
            </button>
            <button
              className="secondary-button"
              type="button"
              data-testid="debug-relaunch-update"
              onClick={() => void relaunchUpdatedApp()}
              disabled={updateAction !== null || !bridge.isDesktop() || !updateStatus}
            >
              {updateAction === "relaunch" ? t("debug.updateSwitching") : t("debug.updateSwitch")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void copyToClipboard()}
              disabled={!combined}
            >
              {copied ? t("debug.copied") : t("debug.copy")}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                clearPipelineStageEvents();
                setChunkTiming(getChunkTimingStats());
              }}
              disabled={stageEvents.length === 0}
            >
              {t("debug.clearStages")}
            </button>
            <label className="debug-verbose-toggle">
              <input
                type="checkbox"
                checked={verboseLogging}
                disabled={savingVerbose}
                onChange={(event) => {
                  void toggleVerboseLogging(event.target.checked);
                }}
              />
              <span>{t("debug.verboseLogging")}</span>
            </label>
            <label className="debug-log-level">
              <span>{t("debug.logLevel")}</span>
              <select
                data-testid="debug-log-level"
                value={logLevel}
                disabled={savingLogLevel}
                onChange={(event) => {
                  void changeLogLevel(event.target.value as LogLevel);
                }}
              >
                {LOG_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-button"
              type="button"
              data-testid="debug-export-jsonl"
              onClick={() => exportLogsDownload("jsonl")}
              disabled={structuredLogs.length === 0}
            >
              {t("debug.exportJsonl")}
            </button>
            <button
              className="secondary-button"
              type="button"
              data-testid="debug-export-json"
              onClick={() => exportLogsDownload("json")}
              disabled={structuredLogs.length === 0}
            >
              {t("debug.exportJson")}
            </button>
            <button
              className="secondary-button"
              type="button"
              data-testid="debug-export-log-dir"
              onClick={() => void exportLogsToDir()}
              disabled={structuredLogs.length === 0}
            >
              {t("debug.exportToLogDir")}
            </button>
            <button
              className="secondary-button"
              type="button"
              data-testid="debug-clear-logs"
              onClick={() => clearStructuredLogs()}
              disabled={structuredLogs.length === 0}
            >
              {t("debug.clearLogs")}
            </button>
          </div>
          <p className="debug-inline-meta">{t("debug.verboseLoggingHelp")}</p>
          <p className="debug-inline-meta">{t("debug.logLevelHelp")}</p>
          <section className="debug-section" data-testid="debug-recognition">
            <h4 className="debug-section-title">{t("debug.recognitionMode")}</h4>
            <p className="debug-inline-meta">{t("debug.recognitionModeHint")}</p>
            <div className="debug-kv-list">
              <div>
                <span>{recognitionModeLabel(recognitionMode, t)}</span>
                <code data-testid="debug-recognition-mode">{recognitionMode}</code>
              </div>
            </div>
            <p className="debug-inline-meta">{recognitionModeDescription(recognitionMode, t)}</p>
            <div className="debug-test-caption" data-testid="debug-test-caption">
              <p className="debug-inline-meta">{t("debug.testCaptionHint")}</p>
              <label className="field" htmlFor="debug-test-caption-input">
                <span>{t("debug.testCaptionTitle")}</span>
                <textarea
                  id="debug-test-caption-input"
                  rows={2}
                  value={testCaptionText}
                  placeholder={t("debug.testCaptionPlaceholder")}
                  aria-label={t("debug.testCaptionPlaceholder")}
                  data-testid="debug-test-caption-input"
                  onChange={(event) => {
                    setTestCaptionText(event.currentTarget.value);
                    setTestCaptionNotice(null);
                    setTestCaptionError(null);
                  }}
                  disabled={testCaptionRunning}
                />
              </label>
              <div className="debug-actions">
                <button
                  className="secondary-button"
                  type="button"
                  data-testid="debug-test-caption-publish"
                  onClick={() => void publishTestCaption()}
                  disabled={testCaptionRunning}
                >
                  {testCaptionRunning ? t("debug.testCaptionSending") : t("debug.testCaptionSend")}
                </button>
                <span
                  className="debug-inline-meta"
                  data-testid="debug-test-caption-state"
                  data-status={
                    testCaptionRunning
                      ? "running"
                      : testCaptionError
                        ? "error"
                        : testCaptionNotice
                          ? "success"
                          : "ready"
                  }
                  role="status"
                >
                  {testCaptionRunning
                    ? t("debug.testCaptionSending")
                    : (testCaptionError ?? testCaptionNotice ?? t("debug.testCaptionReady"))}
                </span>
              </div>
              {testCaptionNotice ? (
                <p
                  className="debug-inline-meta"
                  role="status"
                  data-testid="debug-test-caption-notice"
                >
                  {testCaptionNotice}
                </p>
              ) : null}
              {testCaptionError ? (
                <p
                  className="debug-inline-meta is-error"
                  role="alert"
                  data-testid="debug-test-caption-error"
                >
                  {testCaptionError}
                </p>
              ) : null}
            </div>
          </section>
          {exportNotice ? (
            <p className="debug-inline-meta" data-testid="debug-export-notice" role="status">
              {exportNotice}
            </p>
          ) : null}
          {error ? (
            <div className="download-message error notice" role="alert">
              <span className="notice-text">{error}</span>
              <button className="notice-dismiss" type="button" onClick={() => setError(null)}>
                {t("common.close")}
              </button>
            </div>
          ) : null}
          {lastError ? (
            <div className="download-message error notice" role="status">
              <span className="notice-text">
                <strong>{t("debug.lastError")}: </strong>
                {lastError}
              </span>
            </div>
          ) : null}
          {combined ? (
            <>
              <section className="debug-summary-grid" aria-label={t("debug.summaryTitle")}>
                <div className="debug-stat-card">
                  <span className="debug-stat-label">{t("debug.envTitle")}</span>
                  <strong>
                    {bridge.isDesktop()
                      ? `${asString(pick(env, "pkgVersion") ?? pick(backendInfo, "version"))} · ${asString(pick(env, "platform") ?? pick(backendInfo, "platform"))}/${asString(pick(env, "arch") ?? pick(backendInfo, "arch"))}`
                      : asString(pick(frontendInfo, "runtime"), t("live.browserPreview"))}
                  </strong>
                  {bridge.isDesktop() ? (
                    <small>
                      Rust {asString(pick(env, "rustcVersion"))} · Tauri{" "}
                      {asString(pick(env, "tauriVersion"))}
                    </small>
                  ) : (
                    <small>{t("debug.frontendOnlyNote")}</small>
                  )}
                  <small>
                    {t("debug.frontendRuntime")}: {asString(pick(frontendInfo, "runtime"))}
                  </small>
                </div>
                <div className="debug-stat-card">
                  <span className="debug-stat-label">{t("debug.runtimeTitle")}</span>
                  <strong>{asString(pick(runtimeStatus, "status"), t("debug.unknown"))}</strong>
                  <small>
                    {t("debug.nativeOutput")}: {asString(pick(runtimeStatus, "nativeOutput"))}
                  </small>
                  <small>
                    {t("debug.backendReachable")}:{" "}
                    {asString(pick(runtimeStatus, "backendReachable"), t("debug.unknown"))}
                  </small>
                </div>
                <div className="debug-stat-card">
                  <span className="debug-stat-label">{t("debug.modelsTitle")}</span>
                  <strong>
                    {modelStatus.length > 0
                      ? `${downloadReady} / ${modelStatus.length}`
                      : `${asString(pick(modelSummary, "ready"), "0")} / ${asString(pick(modelSummary, "total"), "0")}`}{" "}
                    {t("debug.modelsReady")}
                  </strong>
                  <small className="debug-path">{asString(pick(backendInfo, "modelsDir"))}</small>
                  <small className="debug-path">
                    {t("debug.logDir")}:{" "}
                    {asString(
                      (() => {
                        const direct = pick(backendInfo, "logDir");
                        if (direct !== undefined && direct !== null && direct !== "") {
                          return direct;
                        }
                        const debug = pick(backendInfo, "debug");
                        return isRecord(debug) ? debug["logDir"] : undefined;
                      })(),
                    )}
                  </small>
                  {downloadBusy > 0 ? (
                    <small>
                      {t("debug.modelDownloading")}: {downloadBusy}
                    </small>
                  ) : null}
                </div>
                <div className="debug-stat-card">
                  <span className="debug-stat-label">{t("debug.audioTitle")}</span>
                  <strong>
                    {pick(frontendAudio, "audioContext")
                      ? t("debug.audioOk")
                      : t("debug.audioMissing")}
                  </strong>
                  <small>getUserMedia: {asString(pick(frontendAudio, "getUserMedia"))}</small>
                  <small className="debug-path">
                    {frontendViewport
                      ? `${asString(pick(frontendViewport, "width"))}×${asString(pick(frontendViewport, "height"))} @${asString(pick(frontendViewport, "devicePixelRatio"))}x`
                      : "—"}
                  </small>
                </div>
              </section>

              {updateStatus ? (
                <div className="debug-section" data-testid="debug-update-status">
                  <h4 className="debug-section-title">{t("debug.updateTitle")}</h4>
                  <ul className="debug-kv-list">
                    {updateRows.map((row) => (
                      <li className={row.error ? "is-error" : undefined} key={row.label}>
                        <span>{row.label}</span>
                        <code data-testid={row.testId}>{row.value}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {sidecars.length > 0 ? (
                <div className="debug-section" data-testid="debug-sidecars">
                  <h4 className="debug-section-title">{t("debug.sidecarsTitle")}</h4>
                  <ul className="debug-kv-list">
                    {sidecarRows.map((row) => (
                      <li key={row.id} data-testid="debug-sidecar-row">
                        <span>{row.label}</span>
                        <code>{row.detail}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="debug-section">
                <h4 className="debug-section-title">{t("debug.recentErrorsTitle")}</h4>
                {recentErrors.length === 0 ? (
                  <p className="download-empty">{t("debug.noRecentErrors")}</p>
                ) : (
                  <ul className="debug-error-list">
                    {recentErrors.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="debug-section" data-testid="debug-structured-logs">
                <h4 className="debug-section-title">{t("debug.structuredLogsTitle")}</h4>
                <p className="debug-inline-meta">{t("debug.structuredLogsLead")}</p>
                <p className="debug-inline-meta">
                  {t("debug.logLevelLabel")}: <code>{logLevel}</code> · {structuredLogs.length} rows
                </p>
                {structuredLogs.length === 0 ? (
                  <p className="download-empty">{t("debug.noStructuredLogs")}</p>
                ) : (
                  <ul className="debug-structured-log-list" data-testid="debug-structured-log-list">
                    {structuredLogs.map((entry) => (
                      <li
                        key={entry.id}
                        className={`debug-structured-log-row debug-log-${entry.level}${
                          entry.error ? " is-error" : ""
                        }`}
                        data-testid="debug-structured-log-row"
                        data-log-level={entry.level}
                        data-log-source={entry.source}
                      >
                        <div className="debug-structured-log-main">
                          <span className="debug-event-kind">{entry.level}</span>
                          <span className="debug-log-source">
                            {t("debug.logSource")}: {entry.source}
                          </span>
                          {entry.stage ? (
                            <span className="debug-stage-status">{entry.stage}</span>
                          ) : null}
                          {entry.durationMs != null ? (
                            <span className="debug-stage-ms">{formatMs(entry.durationMs)}</span>
                          ) : null}
                        </div>
                        <code className="debug-path debug-stage-text">
                          {formatStructuredLogLine(entry)}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="debug-section" data-testid="debug-pipeline-stages">
                <h4 className="debug-section-title">{t("debug.pipelineStagesTitle")}</h4>
                <p className="debug-inline-meta">{t("debug.pipelineStagesLead")}</p>
                <div className="debug-stage-grid">
                  {STAGE_NAMES.map((name) => {
                    // Prefer React state (newest-first stageEvents) so open-panel
                    // subscription updates re-render cards without a store reread race.
                    const latest =
                      stageEvents.find((event) => event.stage === name) ??
                      getLatestPipelineStageByName(name);
                    return (
                      <article
                        key={name}
                        className={`debug-stage-card debug-stage-${name}${latest && !latest.ok ? " is-error" : ""}`}
                        data-testid={`debug-stage-${name}`}
                      >
                        <header className="debug-stage-card-head">
                          <strong>{stageDisplayLabel(name)}</strong>
                          <span className="debug-stage-ms" data-testid={`debug-stage-${name}-ms`}>
                            {latest ? formatMs(latest.durationMs) : "—"}
                          </span>
                        </header>
                        {latest ? (
                          <ul className="debug-kv-list">
                            <li>
                              <span>{t("debug.stageStatus")}</span>
                              <code>
                                {latest.ok ? t("debug.stageOk") : t("debug.stageFailed")}
                                {latest.error ? ` · ${latest.error}` : ""}
                              </code>
                            </li>
                            <li>
                              <span>{t("debug.stageUtterance")}</span>
                              <code className="debug-path">{latest.utteranceId || "—"}</code>
                            </li>
                            <li>
                              <span>{t("debug.stageModel")}</span>
                              <code className="debug-path">{latest.modelId || "—"}</code>
                            </li>
                            <li>
                              <span>{t("debug.stageInput")}</span>
                              <code className="debug-path debug-stage-text">
                                {latest.inputSnippet || "—"}
                              </code>
                            </li>
                            <li>
                              <span>{t("debug.stageOutput")}</span>
                              <code className="debug-path debug-stage-text">
                                {latest.outputText || "—"}
                              </code>
                            </li>
                            <li>
                              <span>{t("debug.stageStart")}</span>
                              <code data-testid={`debug-stage-${name}-start`}>
                                {formatStageAt(latest.startedAt, locale)}
                              </code>
                            </li>
                            <li>
                              <span>{t("debug.stageEnd")}</span>
                              <code data-testid={`debug-stage-${name}-end`}>
                                {formatStageAt(latest.at, locale)}
                              </code>
                            </li>
                            <li>
                              <span>{t("debug.stageDuration")}</span>
                              <code>{formatMs(latest.durationMs)}</code>
                            </li>
                          </ul>
                        ) : (
                          <p className="download-empty">{t("debug.stageEmpty")}</p>
                        )}
                      </article>
                    );
                  })}
                </div>

                <h5 className="debug-subsection-title">{t("debug.utterancesTitle")}</h5>
                {utteranceGroups.length === 0 ? (
                  <p className="download-empty">{t("debug.noStageEvents")}</p>
                ) : (
                  <ul className="debug-utterance-list" data-testid="debug-utterance-list">
                    {utteranceGroups.map((group) => (
                      <li
                        key={group.utteranceId}
                        className={`debug-utterance${group.ok ? "" : " is-error"}`}
                        data-testid="debug-utterance-row"
                        data-utterance-id={group.utteranceId}
                      >
                        <header className="debug-utterance-head">
                          <strong className="debug-path">{group.utteranceId}</strong>
                          <span className="debug-stage-ms">
                            {formatMs(group.totalDurationMs)} · {formatStageAt(group.at, locale)}
                          </span>
                        </header>
                        <ul className="debug-stage-row-list" data-testid="debug-stage-feed">
                          {group.stages.map((event) => (
                            <li
                              key={`${group.utteranceId}-${event.stage}-${event.at}-${event.durationMs}-${event.outputText}`}
                              className={`debug-stage-row debug-stage-row-${event.stage}${event.ok ? "" : " is-error"}`}
                              data-testid={`debug-stage-row-${event.stage}`}
                            >
                              <div className="debug-stage-row-main">
                                <span className="debug-event-kind">
                                  {stageDisplayLabel(String(event.stage))}
                                </span>
                                <span className="debug-stage-ms">{formatMs(event.durationMs)}</span>
                                <span className="debug-stage-relative">
                                  {formatRelativeOffset(relativeStageOffsetMs(event, group))}
                                </span>
                                <span className="debug-stage-status">
                                  {event.ok ? t("debug.stageOk") : t("debug.stageFailed")}
                                </span>
                              </div>
                              <code className="debug-path debug-stage-row-output debug-stage-text">
                                {event.outputText || "—"}
                              </code>
                              <code className="debug-path debug-stage-row-timing">
                                {stageTimingSummary(event, locale)}
                              </code>
                              <code className="debug-path debug-stage-row-meta">
                                {event.modelId ? `model=${event.modelId}` : "model=—"}
                                {event.inputSnippet ? ` · in=${event.inputSnippet}` : ""}
                                {event.error ? ` · err=${event.error}` : ""}
                              </code>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <section className="debug-section" data-testid="debug-pipeline-drops">
                <h4 className="debug-section-title">{t("debug.pipelineDropsTitle")}</h4>
                <p className="debug-inline-meta">{t("debug.pipelineDropsLead")}</p>
                <div className="debug-summary-grid">
                  <div className="debug-stat-card" data-testid="debug-pipeline-drop-total">
                    <span className="debug-stat-label">{t("debug.pipelineDropsTotal")}</span>
                    <strong>{pipelineDrops.total}</strong>
                  </div>
                  {nativeTranslationRetired != null ? (
                    <div className="debug-stat-card" data-testid="debug-translation-retired">
                      <span className="debug-stat-label">
                        {t("debug.pipelineDropsTranslationRetired")}
                      </span>
                      <strong>{nativeTranslationRetired}</strong>
                    </div>
                  ) : null}
                  {nativeParapperOutputSuperseded != null ? (
                    <div className="debug-stat-card" data-testid="debug-parapper-output-superseded">
                      <span className="debug-stat-label">
                        {t("debug.pipelineDropsParapperOutputSuperseded")}
                      </span>
                      <strong>{nativeParapperOutputSuperseded}</strong>
                    </div>
                  ) : null}
                  {nativeSourceCaptionStaleDropped != null ? (
                    <div
                      className="debug-stat-card"
                      data-testid="debug-source-caption-stale-dropped"
                    >
                      <span className="debug-stat-label">
                        {t("debug.pipelineDropsSourceCaptionStaleDropped")}
                      </span>
                      <strong>{nativeSourceCaptionStaleDropped}</strong>
                    </div>
                  ) : null}
                  {nativeUnfencedCaptionAccepted != null ? (
                    <div className="debug-stat-card" data-testid="debug-unfenced-caption-accepted">
                      <span className="debug-stat-label">
                        {t("debug.pipelineDropsUnfencedCaptionAccepted")}
                      </span>
                      <strong>{nativeUnfencedCaptionAccepted}</strong>
                    </div>
                  ) : null}
                </div>
                <h5 className="debug-subsection-title">{t("debug.pipelineDropsSources")}</h5>
                <ul className="debug-kv-list" data-testid="debug-pipeline-drop-sources">
                  {pipelineDropSourceRows.map(({ source, count }) => (
                    <li
                      key={source}
                      data-testid={`debug-pipeline-drop-source-${source.replaceAll("_", "-")}`}
                    >
                      <span>{pipelineDropSourceLabel(source, t)}</span>
                      <code>{count}</code>
                    </li>
                  ))}
                </ul>
                <h5 className="debug-subsection-title">{t("debug.pipelineDropsReasons")}</h5>
                {pipelineDropReasonRows.length === 0 ? (
                  <p className="download-empty">{t("debug.pipelineDropsNone")}</p>
                ) : (
                  <ul className="debug-kv-list" data-testid="debug-pipeline-drop-reasons">
                    {pipelineDropReasonRows.map(([reason, count]) => (
                      <li key={reason}>
                        <span>{reason}</span>
                        <code>{count}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <div className="debug-section" data-testid="debug-chunk-timing">
                <h4 className="debug-section-title">{t("debug.chunkTimingTitle")}</h4>
                <ul className="debug-kv-list">
                  <li>
                    <span>{t("debug.chunkLastPipeline")}</span>
                    <code>{formatMs(chunkTiming.lastPipelineMs)}</code>
                  </li>
                  <li>
                    <span>{t("debug.chunkFirstCaption")}</span>
                    <code>{formatMs(chunkTiming.lastFirstCaptionMs)}</code>
                  </li>
                  <li>
                    <span>{t("debug.displaySourcePipeline")}</span>
                    <code>{formatMs(displayTiming.sourceSincePipelineStartMs)}</code>
                  </li>
                  <li>
                    <span>{t("debug.displaySourceEvent")}</span>
                    <code>{formatMs(displayTiming.sourceEventToPaintMs)}</code>
                  </li>
                  <li>
                    <span>{t("debug.displayTranslationPipeline")}</span>
                    <code>{formatMs(displayTiming.translationSincePipelineStartMs)}</code>
                  </li>
                  <li>
                    <span>{t("debug.displayTranslationEvent")}</span>
                    <code>{formatMs(displayTiming.translationEventToPaintMs)}</code>
                  </li>
                  <li>
                    <span>{t("debug.displayTranslationLag")}</span>
                    <code>{formatMs(displayTiming.translationSinceSourcePaintMs)}</code>
                  </li>
                  <li>
                    <span>{t("debug.chunkProcessed")}</span>
                    <code>{chunkTiming.chunksProcessed}</code>
                  </li>
                  <li>
                    <span>{t("debug.chunkDropped")}</span>
                    <code>{chunkTiming.chunksDropped}</code>
                  </li>
                  <li>
                    <span>{t("debug.chunkInFlight")}</span>
                    <code>
                      {chunkTiming.inFlight ? t("debug.yes") : t("debug.no")}
                      {chunkTiming.hasPending ? ` · ${t("debug.chunkPending")}` : ""}
                    </code>
                  </li>
                </ul>
              </div>

              {captureInfo ? (
                <div className="debug-section">
                  <h4 className="debug-section-title">{t("debug.audioCaptureTitle")}</h4>
                  <ul className="debug-kv-list">
                    <li>
                      <span>
                        {captureInfo.active ? t("debug.audioActive") : t("debug.audioInactive")}
                        {captureInfo.trackMuted ? ` · ${t("debug.audioMuted")}` : ""}
                      </span>
                      <code>
                        {t("debug.audioCaptureMode")}: {captureInfo.captureMode} ·{" "}
                        {t("debug.audioConstraintMode")}: {captureInfo.constraintMode ?? "—"}
                      </code>
                    </li>
                    <li>
                      <span>
                        {t("debug.audioContextState")}: {captureInfo.contextState ?? "—"}
                      </span>
                      <code>
                        {t("debug.audioSampleRate")}:{" "}
                        {captureInfo.sampleRate != null ? `${captureInfo.sampleRate} Hz` : "—"} ·{" "}
                        {t("debug.audioTrackState")}: {captureInfo.trackReadyState ?? "—"}
                      </code>
                    </li>
                    <li>
                      <span>
                        {t("debug.selectedDevice")}:{" "}
                        {captureInfo.trackLabel ||
                          captureInfo.deviceIdRequested ||
                          selectedDeviceId ||
                          "—"}
                      </span>
                      <code className="debug-path">
                        id={captureInfo.deviceIdRequested ?? selectedDeviceId}
                        {captureInfo.lastErrorCode ? ` · code=${captureInfo.lastErrorCode}` : ""}
                        {captureInfo.lastErrorAt ? ` · at=${captureInfo.lastErrorAt}` : ""}
                      </code>
                    </li>
                  </ul>
                </div>
              ) : null}

              <div className="debug-section">
                <h4 className="debug-section-title">{t("debug.devicesTitle")}</h4>
                {devices.length === 0 ? (
                  <p className="download-empty">{t("debug.noDevices")}</p>
                ) : (
                  <>
                    <p className="debug-inline-meta">
                      {t("debug.deviceCount", { count: devices.length })} ·{" "}
                      {t("debug.selectedDevice")}: {selectedDeviceId || "default"}
                    </p>
                    <ul className="debug-kv-list">
                      {devices.map((device, index) => {
                        const selected =
                          device.deviceId === selectedDeviceId ||
                          (selectedDeviceId === "default" && device.deviceId === "default");
                        return (
                          <li key={device.deviceId || `device-${index}`}>
                            <span>
                              {deviceLabel(device, t, index)}
                              {selected ? ` · ${t("debug.selectedDevice")}` : ""}
                            </span>
                            <code className="debug-path">
                              {device.deviceId || "—"}
                              {device.groupId ? ` · group=${device.groupId}` : ""}
                            </code>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>

              <div className="debug-section">
                <h4 className="debug-section-title">{t("debug.previewTitle")}</h4>
                <ul className="debug-kv-list">
                  <li>
                    <span>
                      {t("debug.overlaySize")}:{" "}
                      {overlayConfig
                        ? `${asString(pick(overlayConfig, "width"))} × ${asString(pick(overlayConfig, "height"))}`
                        : t("debug.unknown")}
                    </span>
                    <code>
                      {t("debug.captionOrder")}: {asString(pick(overlayConfig, "order"))} · x=
                      {asString(pick(overlayConfig, "captionXPercent"))}% · y=
                      {asString(pick(overlayConfig, "captionYPercent"))}% · gap=
                      {asString(pick(overlayConfig, "gapPx"))}px
                    </code>
                  </li>
                  <li>
                    <span>
                      {t("debug.previewMode")}: {t("debug.previewLive")}
                    </span>
                    <code>
                      {t("debug.chunkMs")}: {asString(pick(audioConfig, "chunkMs"))} ms ·{" "}
                      {t("debug.silenceGate")}: {asString(pick(audioConfig, "silenceGateDb"))} dB ·{" "}
                      {t("debug.adaptiveNoiseFloor")}:{" "}
                      {pick(audioConfig, "adaptiveNoiseFloor") === false
                        ? t("debug.off")
                        : t("debug.on")}{" "}
                      · {t("debug.noiseSuppression")}:{" "}
                      {pick(audioConfig, "noiseSuppression") === false
                        ? t("debug.off")
                        : t("debug.on")}{" "}
                      · {t("debug.autoGainControl")}:{" "}
                      {pick(audioConfig, "autoGainControl") === false
                        ? t("debug.off")
                        : t("debug.on")}{" "}
                      · sampleRate={asString(pick(audioConfig, "sampleRate"))} · device=
                      {selectedDeviceId}
                    </code>
                  </li>
                </ul>
              </div>

              <div className="debug-section">
                <h4 className="debug-section-title">{t("debug.downloadTitle")}</h4>
                {modelStatus.length === 0 ? (
                  <p className="download-empty">{t("debug.downloadEmpty")}</p>
                ) : (
                  <ul className="debug-kv-list">
                    {modelStatus.map((entry) => (
                      <li key={entry.modelId}>
                        <span>
                          {entry.label || entry.modelId}
                          {entry.role ? ` · ${entry.role}` : ""}{" "}
                          <span className={`debug-download-chip status-${entry.status}`}>
                            {modelInstallLabel(String(entry.status), t)}
                          </span>
                        </span>
                        <code className="debug-path">
                          {formatBytes(entry.installedBytes)}
                          {entry.expectedBytes > 0
                            ? ` / ${formatBytes(entry.expectedBytes)}`
                            : ""}
                          {entry.sourceUrl ? ` · ${t("debug.modelSource")}: ${entry.sourceUrl}` : ""}
                          {entry.localPath ? ` · ${t("debug.modelPath")}: ${entry.localPath}` : ""}
                          {entry.lastError ? ` · ${entry.lastError}` : ""}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {serviceRows.length > 0 ? (
                <div className="debug-section">
                  <h4 className="debug-section-title">{t("debug.servicesTitle")}</h4>
                  <ul className="debug-kv-list">
                    {serviceRows.map((row) => (
                      <li key={row.name}>
                        <span>{row.name}</span>
                        <code>{row.detail}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {modelRows.length > 0 ? (
                <div className="debug-section">
                  <h4 className="debug-section-title">{t("debug.modelListTitle")}</h4>
                  <ul className="debug-kv-list">
                    {modelRows.map((row) => (
                      <li key={row.id}>
                        <span>
                          {row.id} · {row.state}
                        </span>
                        <code className="debug-path">
                          {row.path}
                          {row.bytes !== "—" ? ` · ${row.bytes} B` : ""}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="debug-section">
                <h4 className="debug-section-title">{t("debug.eventsTitle")}</h4>
                {events.length === 0 ? (
                  <p className="download-empty">{t("debug.noEvents")}</p>
                ) : (
                  <ul className="debug-event-list">
                    {events.map((event) => (
                      <li key={event.id} className={`debug-event debug-event-${event.kind}`}>
                        <div className="debug-event-meta">
                          <span className="debug-event-kind">{event.kind}</span>
                          <time dateTime={event.at}>{formatEventTime(event.at, locale)}</time>
                        </div>
                        <strong>{event.message}</strong>
                        {event.detail ? <code className="debug-path">{event.detail}</code> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="debug-section">
                <h4 className="debug-section-title">{t("debug.rawTitle")}</h4>
                <pre className="debug-output">{JSON.stringify(combined, null, 2)}</pre>
              </div>
            </>
          ) : (
            <p className="download-empty">{loading ? t("debug.loading") : t("debug.empty")}</p>
          )}
        </div>
      </details>
    </section>
  );
}
