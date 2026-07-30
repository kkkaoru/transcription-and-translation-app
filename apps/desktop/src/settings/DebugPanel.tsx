import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AudioCaptureDiagnostics,
  enumerateAudioInputDevices,
  getLastAudioCaptureDiagnostics,
} from "../core/audio";
import { bridge } from "../core/bridge";
import { type DiagnosticEvent, getDiagnosticEvents } from "../core/diagnostics";
import type { AudioInputDevice, ModelStatusEntry } from "../core/types";
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

export function DebugPanel() {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [backendInfo, setBackendInfo] = useState<JsonObject | null>(null);
  const [frontendInfo, setFrontendInfo] = useState<JsonObject | null>(null);
  const [captureInfo, setCaptureInfo] = useState<AudioCaptureDiagnostics | null>(null);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelStatusEntry[]>([]);
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const combined = useMemo(() => {
    if (
      !backendInfo &&
      !frontendInfo &&
      !captureInfo &&
      devices.length === 0 &&
      modelStatus.length === 0 &&
      events.length === 0
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
    };
  }, [backendInfo, frontendInfo, captureInfo, devices, modelStatus, events]);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    setError(null);
    const nextFrontend = collectFrontendDiagnostics();
    const nextCapture = getLastAudioCaptureDiagnostics();
    const nextEvents = getDiagnosticEvents();
    setFrontendInfo(nextFrontend);
    setCaptureInfo(nextCapture);
    setEvents(nextEvents);
    try {
      const [info, nextDevices, nextModelStatus] = await Promise.all([
        bridge.getDebugInfo(),
        enumerateAudioInputDevices().catch(() => [] as AudioInputDevice[]),
        bridge.listModelStatus().catch(() => [] as ModelStatusEntry[]),
      ]);
      setBackendInfo(isRecord(info) ? info : { value: info });
      setDevices(nextDevices);
      setModelStatus(nextModelStatus);
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
          </div>
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
                    {asString(pick(env, "pkgVersion") ?? pick(backendInfo, "version"))} ·{" "}
                    {asString(pick(env, "platform") ?? pick(backendInfo, "platform"))}/
                    {asString(pick(env, "arch") ?? pick(backendInfo, "arch"))}
                  </strong>
                  <small>
                    Rust {asString(pick(env, "rustcVersion"))} · Tauri{" "}
                    {asString(pick(env, "tauriVersion"))}
                  </small>
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
