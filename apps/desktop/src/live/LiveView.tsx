import type { ChangeEventHandler, CSSProperties } from "react";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AudioDeviceSelect } from "../components/AudioDeviceSelect";
import { Field } from "../components/Field";
import { rmsDbToMeterLevel } from "../core/audio";
import { bridge } from "../core/bridge";
import { getInputLevelDb, subscribeInputLevel } from "../core/input-level";
import { computePreviewFitScale } from "../core/style";
import type {
  AppConfig,
  AudioInputDevice,
  CaptionPayload,
  RecognitionMode,
  RuntimeStatus,
} from "../core/types";
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

/**
 * Level meter only — subscribes to the input-level store so ~12 Hz RMS ticks
 * never re-render the caption preview or transcript panel.
 */
const InputLevelMeter = memo(
  ({
    capturing,
    waitingLabel,
    disconnectedLabel,
    ariaLabel,
  }: {
    capturing: boolean;
    waitingLabel: string;
    disconnectedLabel: string;
    ariaLabel: string;
  }) => {
    const inputLevelDb = useSyncExternalStore(
      subscribeInputLevel,
      getInputLevelDb,
      getInputLevelDb,
    );
    const meterLevel = capturing ? rmsDbToMeterLevel(inputLevelDb) : 0;
    const meterLabel =
      capturing && inputLevelDb !== null && Number.isFinite(inputLevelDb)
        ? `${inputLevelDb.toFixed(0)} dB`
        : capturing
          ? waitingLabel
          : disconnectedLabel;
    return (
      <div className={`input-level${capturing ? " active" : ""}`} data-testid="input-level-meter">
        <meter
          className="input-level-meter"
          min={0}
          max={1}
          low={0.25}
          high={0.85}
          optimum={0.55}
          value={meterLevel}
          aria-label={ariaLabel}
        />
        <span className="input-level-label">{meterLabel}</span>
      </div>
    );
  },
);
InputLevelMeter.displayName = "InputLevelMeter";

/** Caption preview is isolated so sibling panel updates do not re-layout the stage. */
const LiveCaptionPreview = memo(
  ({ config, caption }: { config: AppConfig; caption: CaptionPayload }) => (
    <OverlayView config={config} caption={caption} preview placeholder={false} />
  ),
);
LiveCaptionPreview.displayName = "LiveCaptionPreview";

export const LiveView = ({
  config,
  status,
  caption,
  devices,
  message,
  onToggleCapture,
  onOpenOverlay,
  onCloseOverlay = () => {},
  onDeviceChange,
  onRefreshDevices,
  onCloseMessage,
}: {
  config: AppConfig;
  status: RuntimeStatus;
  caption: CaptionPayload;
  devices: AudioInputDevice[];
  message: string | null;
  onToggleCapture: () => void;
  onOpenOverlay: () => void;
  onCloseOverlay?: () => void;
  onDeviceChange: ChangeEventHandler<HTMLSelectElement>;
  onRefreshDevices: () => void;
  onCloseMessage: () => void;
}) => {
  const { locale, t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const overlayWidth = Math.max(1, config.overlay.width);
  const overlayHeight = Math.max(1, config.overlay.height);
  const previewStyle = useMemo(
    () =>
      ({
        aspectRatio: `${overlayWidth} / ${overlayHeight}`,
        ["--overlay-width" as string]: `${overlayWidth}px`,
        ["--overlay-height" as string]: `${overlayHeight}px`,
      }) satisfies CSSProperties,
    [overlayHeight, overlayWidth],
  );
  const measured = stageSize.width > 1 && stageSize.height > 1;
  const previewScale = measured
    ? computePreviewFitScale(stageSize.width, stageSize.height, overlayWidth, overlayHeight)
    : 1;
  const scaleHostStyle = useMemo((): CSSProperties => {
    if (!measured) {
      // Fill the stage until ResizeObserver reports a size (jsdom / first paint).
      return {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        transform: "none",
      };
    }
    return {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: overlayWidth,
      height: overlayHeight,
      transform: `translate(-50%, -50%) scale(${previewScale})`,
      transformOrigin: "center center",
    };
  }, [measured, overlayHeight, overlayWidth, previewScale]);
  const captionTime = useMemo(() => {
    if (!caption.receivedAt) {
      return "--:--:--";
    }
    return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(caption.receivedAt);
  }, [caption.receivedAt, locale]);
  const capturing = status.status === "capturing";
  const starting = status.status === "starting";
  const mode: RecognitionMode = config.recognitionMode;
  const webSpeechMode = mode === "web-speech";
  const deviceControlsDisabled = starting || webSpeechMode;
  const sourceStageLabel =
    mode === "parapper-raw"
      ? t("settings.recognitionModeParapperRaw")
      : mode === "web-speech"
        ? t("settings.recognitionModeWebSpeech")
        : config.models.normalizer === "azookey-rust"
          ? "AzooKey"
          : config.models.normalizer;

  // Re-bind when overlay design size changes so aspect-ratio restyle is measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: design size is a re-measure trigger, not read in the body
  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const applySize = (width: number, height: number) => {
      setStageSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      applySize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    const rect = node.getBoundingClientRect();
    applySize(rect.width, rect.height);
    return () => observer.disconnect();
  }, [overlayHeight, overlayWidth]);

  const usesNativeTransport =
    status.nativeOutput === "syphon" || status.nativeOutput === "spout2";

  return (
    <>
      <div className="content-heading">
        <div>
          <span className="eyebrow">{t("live.eyebrow")}</span>
          <h2>{t("live.title")}</h2>
        </div>
        <div className="heading-actions">
          {usesNativeTransport ? (
            <span className="live-badge" data-testid="native-always-on">
              {t("live.nativeAlwaysOn")}
            </span>
          ) : (
            <>
              <button className="secondary-button" type="button" onClick={onOpenOverlay}>
                {t("live.openTransparentCapture")}
              </button>
              <button className="secondary-button" type="button" onClick={onCloseOverlay}>
                {t("live.hideTransparentCapture")}
              </button>
            </>
          )}
          <button
            className={`primary-button ${capturing ? "danger" : ""}`}
            type="button"
            onClick={onToggleCapture}
          >
            {/* Startup is cancellable; keep Stop available while status is starting. */}
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
          <div
            className="preview-stage"
            style={previewStyle}
            data-testid="live-preview-stage"
            data-preview-measured={measured ? "true" : "false"}
            data-preview-scale={previewScale.toFixed(4)}
            ref={stageRef}
          >
            <div className="stage-grid" />
            <div className="stage-label">
              {t("live.transparentBadge")} / {overlayWidth} × {overlayHeight}
              {measured ? ` · ${Math.round(previewScale * 100)}%` : ""}
            </div>
            {/* Live caption payload, scaled to stage — no OBS / Virtual Camera required. */}
            <div
              className={`preview-scale-host${measured ? " is-scaled" : " is-fill"}`}
              style={scaleHostStyle}
              data-testid="preview-scale-host"
            >
              <LiveCaptionPreview config={config} caption={caption} />
            </div>
          </div>
          <div className="preview-footer">
            <span>
              <i className="green-dot" /> {t("live.previewWithoutObs")}
            </span>
            <span data-testid="preview-caption-time">{captionTime}</span>
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
                disabled={deviceControlsDisabled}
              />
            </Field>
            <InputLevelMeter
              capturing={capturing}
              waitingLabel={t("live.inputWaiting")}
              disconnectedLabel={t("live.disconnected")}
              ariaLabel={t("live.inputLevel")}
            />
            <button
              className="text-button"
              type="button"
              onClick={onRefreshDevices}
              disabled={deviceControlsDisabled}
            >
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
                title={
                  mode === "web-speech" ? t("settings.recognitionModeWebSpeech") : "Parapper ASR"
                }
                value={
                  mode === "parapper-raw"
                    ? t("settings.recognitionModeParapperRawDescription")
                    : mode === "web-speech"
                      ? t("settings.recognitionModeWebSpeechDescription")
                      : t("live.asr")
                }
                active={capturing}
              />
              <PipelineRow
                number="02"
                title={
                  mode === "parapper-azookey"
                    ? config.models.normalizer === "azookey-rust"
                      ? "AzooKey Rust"
                      : "zenz"
                    : t("live.pipelineInactive")
                }
                value={
                  mode === "parapper-azookey" ? t("live.normalizer") : t("live.pipelineInactive")
                }
                active={capturing && mode === "parapper-azookey"}
              />
              <PipelineRow
                number="03"
                title={mode === "parapper-azookey" ? "Hy-MT2" : t("live.pipelineInactive")}
                value={
                  mode === "parapper-azookey" ? t("live.translation") : t("live.pipelineInactive")
                }
                active={capturing && mode === "parapper-azookey"}
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
          <span
            className="caption-stage-label"
            data-testid="normalized-caption-stage"
            title={sourceStageLabel}
          >
            {sourceStageLabel}
          </span>
          <p
            className={caption.provisional ? "caption-text-provisional" : undefined}
            data-testid="transcript-source-text"
            data-caption-provisional={caption.provisional ? "true" : "false"}
          >
            {caption.sourceText}
          </p>
        </div>
        <div className="transcript-row translation">
          <span className="language-tag blue">EN</span>
          <p>{mode === "parapper-azookey" ? caption.translationText : ""}</p>
        </div>
      </section>
    </>
  );
};
