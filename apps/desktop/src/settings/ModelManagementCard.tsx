import { useCallback, useEffect, useMemo, useState } from "react";
import { bridge, formatBridgeError } from "../core/bridge";
import { pushDiagnosticEvent } from "../core/diagnostics";
import type { DownloadProgress, ModelStatusEntry } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";

const formatBytes = (bytes: number): string => {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
};

const formatDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

const formatSpeed = (bps: number): string => {
  if (bps <= 0) return "—";
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
  return `${(bps / 1024).toFixed(0)} KB/s`;
};

const MODEL_NAMES: Record<string, string> = {
  "zenz-v3.2-xsmall-gguf": "AzooKey Zenzai v3.2 XSmall",
  "zenz-v3.2-small-gguf": "AzooKey Zenzai v3.2 Small",
  "zenz-v2-q5-k-m-gguf": "AzooKey Zenzai v2 Q5_K_M",
  "hy-mt2-1.8b-gguf": "Hy-MT2 1.8B",
  "hy-mt2-7b-gguf": "Hy-MT2 7B",
  "input-n5-lm-v1": "Input N5 LM v1",
  reazonspeech_k2_v2: "ReazonSpeech K2 v2",
  nemotron_3_5_asr_streaming_0_6b_160ms_int8: "Nemotron 3.5 ASR Streaming 160ms",
};

const INPUT_LM_MODEL_ID = "input-n5-lm-v1";

const isParapperAsrModel = (model: ModelStatusEntry): boolean =>
  model.role === "completion" || model.role === "interim";

const displayModelName = (model: ModelStatusEntry): string =>
  model.label ?? MODEL_NAMES[model.modelId] ?? model.modelId;

const statusLabel = (status: string, t: ReturnType<typeof useI18n>["t"]): string => {
  switch (status) {
    case "ready":
      return t("model.statusReady");
    case "missing":
      return t("model.statusMissing");
    case "partial":
      return t("model.statusPartial");
    case "corrupt":
      return t("model.statusCorrupt");
    case "downloading":
      return t("model.statusDownloading");
    case "error":
      return t("model.statusError");
    default:
      return status;
  }
};

const toErrorMessage = (error: unknown): string =>
  formatBridgeError(error) ?? (error instanceof Error ? error.message : String(error));

export const ModelManagementCard = ({ onModelDownloaded }: { onModelDownloaded?: () => void }) => {
  const { t } = useI18n();
  const [models, setModels] = useState<ModelStatusEntry[]>([]);
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress>>({});
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const desktop = bridge.isDesktop();

  const refresh = useCallback(() => {
    if (!desktop) {
      setModels([]);
      return;
    }
    bridge
      .listModelStatus()
      .then(setModels)
      .catch((e) => setError(toErrorMessage(e)));
  }, [desktop]);

  useEffect(() => {
    refresh();
    if (!desktop) return;
    const disposers: Array<() => void> = [];
    bridge
      .listenDownloadProgress((progress) => {
        setDownloading((prev) => {
          const wasTracking = Boolean(prev[progress.modelId]);
          if (!wasTracking || progress.percent >= 100) {
            pushDiagnosticEvent(
              "download",
              progress.percent >= 100
                ? `Download complete: ${progress.modelId}`
                : `Download progress: ${progress.modelId}`,
              `${Math.round(progress.percent)}% · ${progress.downloadedBytes}/${progress.totalBytes} B`,
            );
          }
          return { ...prev, [progress.modelId]: progress };
        });
        if (progress.percent >= 100) {
          setTimeout(() => {
            setDownloading((prev) => {
              const next = { ...prev };
              delete next[progress.modelId];
              return next;
            });
            refresh();
            onModelDownloaded?.();
          }, 400);
        }
      })
      .then((d) => disposers.push(d));
    return () => {
      for (const d of disposers) {
        d();
      }
    };
  }, [refresh, onModelDownloaded, desktop]);

  const summary = useMemo(() => {
    const ready = models.filter((m) => m.status === "ready").length;
    return { ready, total: models.length };
  }, [models]);

  const handleDownload = async (modelId: string) => {
    setError(null);
    setMessage(null);
    try {
      setDownloading((prev) => ({
        ...prev,
        [modelId]: {
          modelId,
          downloadedBytes: 0,
          totalBytes: 0,
          percent: 0,
          speedBps: 0,
          elapsedMs: 0,
        },
      }));
      pushDiagnosticEvent("download", `Download requested: ${modelId}`);
      // The input-LM rescorer model is an archive (ZIP), not a single GGUF file,
      // so it uses a dedicated download command that downloads + extracts.
      if (modelId === INPUT_LM_MODEL_ID) {
        await bridge.downloadInputLmModel();
      } else {
        await bridge.downloadModel(modelId);
      }
      setMessage(t("model.downloadComplete", { id: MODEL_NAMES[modelId] ?? modelId }));
      refresh();
      onModelDownloaded?.();
    } catch (e) {
      const detail = toErrorMessage(e);
      pushDiagnosticEvent("error", `Download failed: ${modelId}`, detail);
      setError(detail);
      setDownloading((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    }
  };

  const handleQuickStart = async () => {
    setError(null);
    setMessage(null);
    setBatchDownloading(true);
    pushDiagnosticEvent("download", "Quick-start pack requested");
    try {
      const ids = await bridge.downloadQuickStart();
      pushDiagnosticEvent("download", "Quick-start pack complete", ids.join(", "));
      setMessage(t("model.quickStartComplete", { count: String(ids.length) }));
      refresh();
      onModelDownloaded?.();
    } catch (e) {
      const detail = toErrorMessage(e);
      pushDiagnosticEvent("error", "Quick-start pack failed", detail);
      setError(detail);
      setDownloading({});
    } finally {
      setBatchDownloading(false);
    }
  };

  const handleCancel = async (modelId: string) => {
    setError(null);
    try {
      await bridge.cancelModelDownload(modelId);
      setMessage(t("model.cancelRequested", { id: MODEL_NAMES[modelId] ?? modelId }));
    } catch (e) {
      setError(toErrorMessage(e));
    }
  };

  return (
    <section className="panel settings-section model-download-panel">
      <div className="download-toolbar">
        <div className="download-summary">
          <h3>{t("model.managementTitle")}</h3>
          <p className="download-lead">{t("model.managementLead")}</p>
          {desktop ? (
            <p className="download-meta">
              {t("model.readyCount", {
                ready: String(summary.ready),
                total: String(summary.total),
              })}
            </p>
          ) : null}
        </div>
        <div className="download-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={refresh}
            disabled={!desktop || batchDownloading}
          >
            {t("model.refreshStatus")}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={handleQuickStart}
            disabled={!desktop || batchDownloading}
          >
            {batchDownloading ? t("model.quickStartRunning") : t("model.quickStart")}
          </button>
        </div>
      </div>

      {!desktop ? (
        <p className="download-browser-note" role="status">
          {t("model.desktopOnly")}
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

      {message ? (
        <p className="download-message success" role="status">
          {message}
        </p>
      ) : null}

      {desktop && models.length === 0 ? (
        <p className="download-empty">{t("model.emptyStatus")}</p>
      ) : null}

      <div className="download-list">
        {models.map((model) => {
          const dp = downloading[model.modelId];
          const status = dp ? "downloading" : model.status;
          const busy = Boolean(dp) || batchDownloading;
          const parapperAsr = isParapperAsrModel(model);
          return (
            <div key={model.modelId} className="download-row">
              <div className="download-row-main">
                <div className="download-row-title">
                  <span className="download-model-id">{displayModelName(model)}</span>
                  <span className={`download-status-chip status-${status}`}>
                    {statusLabel(status, t)}
                  </span>
                </div>
                <div className="download-row-meta">
                  <span>
                    {model.modelId}
                    {model.role ? ` · ${model.role}` : ""}
                  </span>
                  <span>
                    {model.installedBytes != null
                      ? model.expectedBytes > 0
                        ? `${formatBytes(model.installedBytes)} / ${formatBytes(model.expectedBytes)}`
                        : formatBytes(model.installedBytes)
                      : model.expectedBytes > 0
                        ? formatBytes(model.expectedBytes)
                        : "—"}
                  </span>
                  {dp ? (
                    <>
                      <span>{dp.percent}%</span>
                      <span>{formatSpeed(dp.speedBps)}</span>
                      <span>{formatDuration(dp.elapsedMs)}</span>
                    </>
                  ) : null}
                </div>
                {model.modelId === "hy-mt2-7b-gguf" ? (
                  <p className="download-row-source" data-testid="hy-mt2-7b-cost">
                    {t("model.hy7b.description")}
                  </p>
                ) : null}
                {model.sourceUrl ? (
                  <p className="download-row-source">
                    {t("model.sourceUrl")}: <code>{model.sourceUrl}</code>
                  </p>
                ) : null}
                {model.localPath ? (
                  <p className="download-row-source">
                    {t("model.localPath")}: <code>{model.localPath}</code>
                  </p>
                ) : null}
                {dp ? (
                  <div
                    className="download-progress"
                    role="progressbar"
                    aria-valuenow={dp.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div className="download-progress-bar" style={{ width: `${dp.percent}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="download-row-actions">
                {parapperAsr ? (
                  <span className="download-sidecar-note">{t("model.parapperManaged")}</span>
                ) : dp ? (
                  <button
                    className="secondary-button download-one-button"
                    type="button"
                    onClick={() => handleCancel(model.modelId)}
                  >
                    {t("model.cancel")}
                  </button>
                ) : (
                  <button
                    className="secondary-button download-one-button"
                    type="button"
                    disabled={busy || model.status === "ready" || model.status === "downloading"}
                    onClick={() => handleDownload(model.modelId)}
                  >
                    {model.status === "ready"
                      ? t("model.installed")
                      : model.status === "corrupt" || model.status === "partial"
                        ? t("model.redownload")
                        : t("model.download")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {desktop && models.some((m) => m.modelId === INPUT_LM_MODEL_ID) ? (
        <p className="download-section-note">{t("model.inputLmNote")}</p>
      ) : null}
      {desktop && models.some(isParapperAsrModel) ? (
        <p className="download-section-note">{t("model.parapperAsrNote")}</p>
      ) : null}
    </section>
  );
};
