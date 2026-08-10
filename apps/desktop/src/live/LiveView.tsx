import type { ChangeEventHandler, CSSProperties } from "react";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AudioDeviceSelect } from "../components/AudioDeviceSelect";
import { Field } from "../components/Field";
import { rmsDbToMeterLevel } from "../core/audio";
import { getInputLevelDb, subscribeInputLevel } from "../core/input-level";
import { computePreviewFitScale } from "../core/style";
import type { AppConfig, AudioInputDevice, CaptionPayload, RuntimeStatus } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import { OverlayView } from "../overlay/CaptionOverlay";

export type LiveExternalOutput = "syphon" | "spout2" | "transparent-window";

const LIVE_EXTERNAL_OUTPUT_MESSAGE: Record<LiveExternalOutput, MessageKey> = {
  syphon: "live.outputToSyphon",
  spout2: "live.outputToSpout2",
  "transparent-window": "live.outputToTransparentWindow",
};

/** Prefer native transport over the optional transparent capture window. */
export const resolveLiveExternalOutput = (
  nativeOutput: RuntimeStatus["nativeOutput"],
  transparentCaptureOpen: boolean,
): LiveExternalOutput | null => {
  if (nativeOutput === "syphon" || nativeOutput === "spout2") {
    return nativeOutput;
  }
  if (transparentCaptureOpen) {
    return "transparent-window";
  }
  return null;
};

/**
 * Level meter only — subscribes to the input-level store so ~12 Hz RMS ticks
 * never re-render the caption preview.
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
  transparentCaptureOpen = false,
  onToggleCapture,
  onDeviceChange,
  onRefreshDevices,
  onCloseMessage,
  onOpenTransparentCapture,
  onCloseTransparentCapture,
  onOpenStyleEditor,
}: {
  config: AppConfig;
  status: RuntimeStatus;
  caption: CaptionPayload;
  devices: AudioInputDevice[];
  message: string | null;
  transparentCaptureOpen?: boolean;
  onToggleCapture: () => void;
  onDeviceChange: ChangeEventHandler<HTMLSelectElement>;
  onRefreshDevices: () => void;
  onCloseMessage: () => void;
  onOpenTransparentCapture?: () => void;
  onCloseTransparentCapture?: () => void;
  onOpenStyleEditor?: () => void;
}) => {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const overlayWidth = Math.max(1, config.overlay.width);
  const overlayHeight = Math.max(1, config.overlay.height);
  const externalOutput = resolveLiveExternalOutput(status.nativeOutput, transparentCaptureOpen);
  const suppressInAppCaption = externalOutput !== null;
  const previewStyle = useMemo(
    () =>
      ({
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
  const capturing = status.status === "capturing";
  const starting = status.status === "starting";
  const deviceControlsDisabled = starting || config.recognitionMode === "web-speech";

  // Re-bind when overlay design size changes so aspect-ratio restyle is measured.
  // biome-ignore lint/correctness/useExhaustiveDependencies: design size is a re-measure trigger, not read in the body
  useEffect(() => {
    if (suppressInAppCaption) {
      return;
    }
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
  }, [overlayHeight, overlayWidth, suppressInAppCaption]);

  return (
    <div className="live-workspace">
      {message ? (
        <div className="notice" role="status">
          <span className="notice-text">{message}</span>
          <button type="button" onClick={onCloseMessage} aria-label={t("common.close")}>
            ×
          </button>
        </div>
      ) : null}
      <section className="live-stage" aria-label={t("live.previewTitle")}>
        <div
          className={`preview-stage preview-stage--fill${suppressInAppCaption ? " preview-stage--external" : ""}`}
          style={suppressInAppCaption ? undefined : previewStyle}
          data-testid="live-preview-stage"
          data-preview-measured={suppressInAppCaption ? undefined : measured ? "true" : "false"}
          data-preview-scale={suppressInAppCaption ? undefined : previewScale.toFixed(4)}
          ref={suppressInAppCaption ? undefined : stageRef}
        >
          {suppressInAppCaption && externalOutput ? (
            <div
              className="live-output-status"
              data-testid="live-output-status"
              data-output={externalOutput}
              role="status"
            >
              <p className="live-output-status-title">
                {t(LIVE_EXTERNAL_OUTPUT_MESSAGE[externalOutput])}
              </p>
              <p className="live-output-status-hint">{t("live.outputStatusHint")}</p>
            </div>
          ) : (
            <div
              className={`preview-scale-host${measured ? " is-scaled" : " is-fill"}`}
              style={scaleHostStyle}
              data-testid="preview-scale-host"
            >
              <LiveCaptionPreview config={config} caption={caption} />
            </div>
          )}
        </div>
      </section>
      <div className="live-toolbar">
        <div className="live-toolbar-mic">
          <Field label={t("live.microphone")}>
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
            {t("audio.refreshShort")}
          </button>
        </div>
        <div className="live-toolbar-actions">
          {onOpenStyleEditor ? (
            <button
              className="text-button"
              type="button"
              data-testid="open-style-editor"
              onClick={onOpenStyleEditor}
            >
              {t("live.openStyleEditor")}
            </button>
          ) : null}
          {onOpenTransparentCapture ? (
            <button
              className="text-button"
              type="button"
              data-testid="open-transparent-capture"
              onClick={onOpenTransparentCapture}
            >
              {t("live.openTransparentCapture")}
            </button>
          ) : null}
          {onCloseTransparentCapture ? (
            <button
              className="text-button"
              type="button"
              data-testid="hide-transparent-capture"
              onClick={onCloseTransparentCapture}
            >
              {t("live.hideTransparentCapture")}
            </button>
          ) : null}
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
    </div>
  );
};
