import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  type AudioCaptureDiagnostics,
  enumerateAudioInputDevices,
  getLastAudioCaptureDiagnostics,
} from "../core/audio";
import { bridge } from "../core/bridge";
import { type ChunkTimingStats, getChunkTimingStats } from "../core/chunkQueue";
import { mergeConfig } from "../core/defaults";
import { type DiagnosticEvent, getDiagnosticEvents } from "../core/diagnostics";
import {
  clearPipelineStageEvents,
  getLatestPipelineStageByName,
  getPipelineStageEvents,
  getPipelineStageStoreRevision,
  getUtteranceStageGroups,
  isVerbosePipelineLogging,
  setVerbosePipelineLogging,
  stageDisplayLabel,
  subscribePipelineStages,
} from "../core/pipelineStages";
import type { AudioInputDevice, ModelStatusEntry, PipelineStageName } from "../core/types";
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
    href: typeof window !== "undefined" ? window.location.href : null,
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

const STAGE_NAMES: PipelineStageName[] = ["asr", "normalize", "translate"];

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
  return formatEventTime(new Date(ms).toISOString(), locale);
};

export function DebugPanel() {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [backendInfo, setBackendInfo] = useState<JsonObject | null>(null);
  const [frontendInfo, setFrontendInfo] = useState<JsonObject | null>(null);
  const [captureInfo, setCaptureInfo] = useState<AudioCaptureDiagnostics | null>(null);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatusEntry[]>([]);
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  // External store — always subscribed so live stage pushes re-render without open-effect races.
  // Snapshot is a scalar revision; derived arrays are memoized from it (stable getSnapshot).
  const stageStoreRevision = useSyncExternalStore(
    subscribePipelineStages,
    getPipelineStageStoreRevision,
    getPipelineStageStoreRevision,
  );
  // stageStoreRevision is the external-store snapshot; re-read on each change.
  const stageEvents = useMemo(() => {
    void stageStoreRevision;
    return getPipelineStageEvents();
  }, [stageStoreRevision]);
  const utteranceGroups = useMemo(() => {
    void stageStoreRevision;
    return getUtteranceStageGroups();
  }, [stageStoreRevision]);
  const verboseLogging = useMemo(() => {
    void stageStoreRevision;
    return isVerbosePipelineLogging();
  }, [stageStoreRevision]);
  const [chunkTiming, setChunkTiming] = useState<ChunkTimingStats>(() => getChunkTimingStats());
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingVerbose, setSavingVerbose] = useState(false);

  const combined = useMemo(() => {
    if (
      !backendInfo &&
      !frontendInfo &&
      !captureInfo &&
      devices.length === 0 &&
      modelStatus.length === 0 &&
      events.length === 0 &&
      stageEvents.length === 0
    ) {
      return null;
    }
    return {
      frontend: frontendInfo,
      backend: backendInfo,
      audioCapture: captureInfo,
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        label: device.label,
        groupId: device.groupId,
      })),
      modelDownloads: modelStatus,
      recentEvents: events,
      pipelineStages: stageEvents,
      utteranceGroups,
      chunkTiming,
      verbosePipelineLogging: verboseLogging,
    };
  }, [
    backendInfo,
    frontendInfo,
    captureInfo,
    devices,
    modelStatus,
    events,
    stageEvents,
    utteranceGroups,
    chunkTiming,
    verboseLogging,
  ]);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    setError(null);
    const nextFrontend = collectFrontendDiagnostics();
    const nextCapture = getLastAudioCaptureDiagnostics();
    const nextEvents = getDiagnosticEvents();
    setFrontendInfo(nextFrontend);
    setCaptureInfo(nextCapture);
    setEvents(nextEvents);
    setChunkTiming(getChunkTimingStats());
    try {
      const [info, nextDevices, nextModelStatus] = await Promise.all([
        bridge.getDebugInfo(),
        enumerateAudioInputDevices().catch(() => [] as AudioInputDevice[]),
        bridge.listModelStatus().catch(() => [] as ModelStatusEntry[]),
      ]);
      const backend = isRecord(info) ? info : { value: info };
      setBackendInfo(backend);
      setDevices(nextDevices);
      setModelStatus(nextModelStatus);
      // Desktop: prefer persisted Rust config so verbose matches backend logs.
      // Browser preview has no writable backend config — keep localStorage preference.
      if (bridge.isDesktop()) {
        const configValue = isRecord(backend) ? pick(backend, "config") : null;
        const config = isRecord(configValue) ? configValue : null;
        const debugValue = pick(config, "debug") ?? pick(backend, "debug");
        const debug = isRecord(debugValue) ? debugValue : null;
        const verboseFromBackend = pick(debug, "verboseLogging");
        if (typeof verboseFromBackend === "boolean") {
          setVerbosePipelineLogging(verboseFromBackend);
        }
      }
    } catch (e) {
      setBackendInfo(null);
      setError(String(e));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open && !backendInfo && !loading) {
      void fetchInfo();
    }
  }, [open, backendInfo, loading, fetchInfo]);

  // Chunk timing is published from the live capture path; poll snapshot while open.
  useEffect(() => {
    if (!open) {
      return;
    }
    setChunkTiming(getChunkTimingStats());
    const timer = window.setInterval(() => {
      setChunkTiming(getChunkTimingStats());
    }, 500);
    return () => {
      window.clearInterval(timer);
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
        debug: { ...current.debug, verboseLogging: enabled },
      });
      await bridge.saveConfig(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingVerbose(false);
    }
  }, []);

  const copyToClipboard = async () => {
    if (!combined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(combined, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(String(e));
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
    captureInfo?.lastError ?? "",
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

  return (
    <section className="panel settings-section debug-panel">
      <details
        open={open}
        onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="debug-summary">
          <span className="eyebrow">{t("debug.eyebrow")}</span>
          <span className="debug-summary-title">{t("debug.title")}</span>
        </summary>
        <div className="debug-content">
          <p className="download-lead">{t("debug.lead")}</p>
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
          </div>
          <p className="debug-inline-meta">{t("debug.verboseLoggingHelp")}</p>
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
                          <span className="debug-stage-ms">
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
                              <code className="debug-path">{latest.inputSnippet || "—"}</code>
                            </li>
                            <li>
                              <span>{t("debug.stageOutput")}</span>
                              <code className="debug-path">{latest.outputText || "—"}</code>
                            </li>
                            <li>
                              <span>{t("debug.stageAt")}</span>
                              <code>{formatStageAt(latest.at, locale)}</code>
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
                              className={`debug-stage-row${event.ok ? "" : " is-error"}`}
                              data-testid={`debug-stage-row-${event.stage}`}
                            >
                              <div className="debug-stage-row-main">
                                <span className="debug-event-kind">
                                  {stageDisplayLabel(String(event.stage))}
                                </span>
                                <span className="debug-stage-ms">{formatMs(event.durationMs)}</span>
                                <span className="debug-stage-status">
                                  {event.ok ? t("debug.stageOk") : t("debug.stageFailed")}
                                </span>
                              </div>
                              <code className="debug-path debug-stage-row-output">
                                {event.outputText || "—"}
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
                      {t("debug.silenceGate")}: {asString(pick(audioConfig, "silenceGateDb"))} dB ·
                      sampleRate={asString(pick(audioConfig, "sampleRate"))} · device=
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
                          {entry.modelId}{" "}
                          <span className={`debug-download-chip status-${entry.status}`}>
                            {modelInstallLabel(String(entry.status), t)}
                          </span>
                        </span>
                        <code className="debug-path">
                          {formatBytes(entry.installedBytes)} / {formatBytes(entry.expectedBytes)}
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
