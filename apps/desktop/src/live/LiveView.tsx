import type { ChangeEventHandler } from "react";
import { useMemo } from "react";
import { AudioDeviceSelect } from "../components/AudioDeviceSelect";
import { Field } from "../components/Field";
import { rmsDbToMeterLevel } from "../core/audio";
import { bridge } from "../core/bridge";
import type { AppConfig, AudioInputDevice, CaptionPayload, RuntimeStatus } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import { OverlayView } from "../overlay/CaptionOverlay";

const PipelineRow = ({
  number,
  title,
  value,
  active,
}: {
  number: string;
  title: string;
  value: string;
  active: boolean;
}) => (
  <div className="pipeline-row">
    <span className={`pipeline-number ${active ? "active" : ""}`}>{number}</span>
    <span className="pipeline-copy">
      <strong>{title}</strong>
      <small>{value}</small>
    </span>
    <span className={`pipeline-state ${active ? "active" : ""}`} />
  </div>
);

export const LiveView = ({
  config,
  status,
  caption,
  devices,
  message,
  inputLevelDb = null,
  onToggleCapture,
  onOpenOverlay,
  onDeviceChange,
  onRefreshDevices,
  onCloseMessage,
}: {
  config: AppConfig;
  status: RuntimeStatus;
  caption: CaptionPayload;
  devices: AudioInputDevice[];
  message: string | null;
  /** Live microphone RMS in dBFS for the local level meter (no OBS required). */
  inputLevelDb?: number | null;
  onToggleCapture: () => void;
  onOpenOverlay: () => void;
  onDeviceChange: ChangeEventHandler<HTMLSelectElement>;
  onRefreshDevices: () => void;
  onCloseMessage: () => void;
}) => {
  const { locale, t } = useI18n();
  const previewStyle = useMemo(
    () => ({
      aspectRatio: `${config.overlay.width} / ${config.overlay.height}`,
    }),
    [config.overlay.height, config.overlay.width],
  );
  const captionTime = caption.receivedAt
    ? new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(caption.receivedAt)
    : "--:--:--";
  const capturing = status.status === "capturing";
  const starting = status.status === "starting";
  const meterLevel = capturing ? rmsDbToMeterLevel(inputLevelDb) : 0;
  const meterLabel =
    capturing && inputLevelDb !== null && Number.isFinite(inputLevelDb)
      ? `${inputLevelDb.toFixed(0)} dB`
      : capturing
        ? t("live.inputWaiting")
        : t("live.disconnected");

  return (
    <>
      <div className="content-heading">
        <div>
          <span className="eyebrow">{t("live.eyebrow")}</span>
          <h2>{t("live.title")}</h2>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" onClick={onOpenOverlay}>
            {t("live.openOverlay")}
          </button>
          <button
            className={`primary-button ${capturing ? "danger" : ""}`}
            type="button"
            onClick={onToggleCapture}
            disabled={starting}
          >
            <span className="record-dot" />
            {capturing || starting ? t("live.stop") : t("live.start")}
          </button>
        </div>
      </div>
      {message ? (
        <div className="notice" role="status">
          <span className="notice-text">{message}</span>
          <button type="button" onClick={onCloseMessage} aria-label={t("common.close")}>
            ×
          </button>
        </div>
      ) : null}
      <div className="live-grid">
        <section className="panel preview-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("live.previewEyebrow")}</span>
              <h3>{t("live.previewTitle")}</h3>
            </div>
            <span className="live-badge">
              {bridge.isDesktop() ? t("live.tauriWindow") : t("live.browserPreview")}
            </span>
          </div>
          <div className="preview-stage" style={previewStyle} data-testid="live-preview-stage">
            <div className="stage-grid" />
            <div className="stage-label">
              {t("live.transparentBadge")} / {config.overlay.width} × {config.overlay.height}
            </div>
            {/* placeholder=false: show live caption payload in-app without OBS */}
            <OverlayView config={config} caption={caption} preview placeholder={false} />
          </div>
          <div className="preview-footer">
            <span>
              <i className="green-dot" /> {t("live.previewWithoutObs")}
            </span>
            <span>{captionTime}</span>
          </div>
        </section>
        <div className="live-side">
          <section className="panel compact-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">{t("live.audioEyebrow")}</span>
                <h3>{t("live.microphone")}</h3>
              </div>
              <span className="input-status">
                {capturing
                  ? t("live.inputActive")
                  : starting
                    ? t("status.starting")
                    : t("live.disconnected")}
              </span>
            </div>
            <Field label={t("audio.inputDevice")} wide hint={t("audio.inputHint")}>
              <AudioDeviceSelect
                devices={devices}
                value={config.audio.inputDeviceId}
                onChange={onDeviceChange}
              />
            </Field>
            <div
              className={`input-level${capturing ? " active" : ""}`}
              data-testid="input-level-meter"
            >
              <meter
                className="input-level-meter"
                min={0}
                max={1}
                low={0.25}
                high={0.85}
                optimum={0.55}
                value={meterLevel}
                aria-label={t("live.inputLevel")}
              />
              <span className="input-level-label">{meterLabel}</span>
            </div>
            <button className="text-button" type="button" onClick={onRefreshDevices}>
              {t("audio.refresh")}
            </button>
          </section>
          <section className="panel compact-panel pipeline-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">{t("live.pipelineEyebrow")}</span>
                <h3>{t("live.pipelineTitle")}</h3>
              </div>
              <span className="latency-label">{t("live.localBadge")}</span>
            </div>
            <div className="pipeline-list">
              <PipelineRow
                number="01"
                title="Parapper ASR"
                value={t("live.asr")}
                active={capturing}
              />
              <PipelineRow
                number="02"
                title={config.models.normalizer === "azookey-rust" ? "AzooKey Rust" : "zenz"}
                value={t("live.normalizer")}
                active={capturing}
              />
              <PipelineRow
                number="03"
                title="Hy-MT2"
                value={t("live.translation")}
                active={capturing}
              />
            </div>
          </section>
        </div>
      </div>
      <section className="panel transcript-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{t("live.latestEyebrow")}</span>
            <h3>{t("live.latestTitle")}</h3>
          </div>
          <span className="caption-id">{caption.id}</span>
        </div>
        <div className="transcript-row">
          <span className="language-tag">JA</span>
          <p>{caption.sourceText}</p>
        </div>
        <div className="transcript-row translation">
          <span className="language-tag blue">EN</span>
          <p>{caption.translationText}</p>
        </div>
      </section>
    </>
  );
};
