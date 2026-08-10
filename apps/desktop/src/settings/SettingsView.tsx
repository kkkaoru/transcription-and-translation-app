import { type ChangeEvent, useState } from "react";
import { AudioDeviceSelect } from "../components/AudioDeviceSelect";
import { Field } from "../components/Field";
import { BUILD_INFO } from "../core/buildInfo";
import {
  AUDIO_CHUNK_MAX_MS,
  AUDIO_CHUNK_MIN_MS,
  AUDIO_CHUNK_STEP_MS,
  BROWSER_SOURCE_PORT_MAX,
  BROWSER_SOURCE_PORT_MIN,
  DEFAULT_ADAPTIVE_NOISE_FLOOR,
  DEFAULT_AUDIO_CHUNK_MS,
  DEFAULT_BROWSER_SOURCE_PORT,
  DEFAULT_RECOGNITION_MODE,
  DEFAULT_SILENCE_GATE_DB,
  DEFAULT_VAD_INTERVAL_MS,
  DEFAULT_VAD_THRESHOLD,
  ENDPOINT_TIMEOUT_MAX_MS,
  ENDPOINT_TIMEOUT_MIN_MS,
  ENDPOINT_TIMEOUT_STEP_MS,
  isRecognitionMode,
  OVERLAY_DIMENSION_STEP_PX,
  OVERLAY_HEIGHT_MAX_PX,
  OVERLAY_HEIGHT_MIN_PX,
  OVERLAY_WIDTH_MAX_PX,
  OVERLAY_WIDTH_MIN_PX,
  resolveSilenceGateMode,
  SILENCE_GATE_MAX_DB,
  SILENCE_GATE_MIN_DB,
  SILENCE_GATE_STEP_DB,
  VAD_INTERVAL_MAX_MS,
  VAD_INTERVAL_MIN_MS,
  VAD_INTERVAL_STEP_MS,
  VAD_THRESHOLD_DECIMAL_PLACES,
  VAD_THRESHOLD_MAX,
  VAD_THRESHOLD_MIN,
  VAD_THRESHOLD_STEP,
} from "../core/defaults";
import type {
  AppConfig,
  AudioInputDevice,
  ModelCatalog,
  ModelFamily,
  RecognitionMode,
} from "../core/types";
import { isWebSpeechRecognitionSupported } from "../core/webSpeechRecognition";
import { useI18n } from "../i18n/I18nProvider";
import { DebugPanel } from "./DebugPanel";
import { ModelCard } from "./ModelCard";
import { ModelManagementCard } from "./ModelManagementCard";

const SectionHeading = ({ title }: { title: string }) => (
  <div className="section-heading">
    <h3>{title}</h3>
  </div>
);

export const SettingsView = ({
  config,
  models,
  devices,
  saving,
  captureStarting = false,
  desktopStreaming = false,
  onConfigChange,
  onModelChange,
  onDeviceChange,
  onRefreshDevices,
  onSave,
  onOpenTransparentCapture,
  onCloseTransparentCapture,
  webSpeechSupported = isWebSpeechRecognitionSupported(),
}: {
  config: AppConfig;
  models: ModelCatalog;
  devices: AudioInputDevice[];
  saving: boolean;
  /** Prevent capture-affecting edits while MainApp is preparing a session. */
  captureStarting?: boolean;
  /** Native Parapper streaming owns VAD/chunking instead of the browser pipeline. */
  desktopStreaming?: boolean;
  onConfigChange: (next: AppConfig) => void;
  onModelChange: (family: ModelFamily, value: string) => void;
  onDeviceChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onRefreshDevices: () => void;
  onSave: () => void;
  onOpenTransparentCapture?: () => void;
  onCloseTransparentCapture?: () => void;
  webSpeechSupported?: boolean;
}) => {
  const { t } = useI18n();
  const setOverlay = (patch: Partial<AppConfig["overlay"]>) =>
    onConfigChange({ ...config, overlay: { ...config.overlay, ...patch } });
  const setAudio = (patch: Partial<AppConfig["audio"]>) =>
    onConfigChange({ ...config, audio: { ...config.audio, ...patch } });
  const setRescore = (patch: Partial<AppConfig["rescore"]>) =>
    onConfigChange({ ...config, rescore: { ...config.rescore, ...patch } });
  const vadIntervalMs = Number.isFinite(config.audio.vadIntervalMs)
    ? config.audio.vadIntervalMs
    : DEFAULT_VAD_INTERVAL_MS;
  const vadThreshold = Number.isFinite(config.audio.vadThreshold)
    ? config.audio.vadThreshold
    : DEFAULT_VAD_THRESHOLD;
  const recognitionMode: RecognitionMode = isRecognitionMode(config.recognitionMode)
    ? config.recognitionMode
    : DEFAULT_RECOGNITION_MODE;
  const recognitionModeDescription =
    recognitionMode === "parapper-raw"
      ? t("settings.recognitionModeParapperRawDescription")
      : recognitionMode === "web-speech"
        ? t("settings.recognitionModeWebSpeechDescription")
        : t("settings.recognitionModeParapperAzookeyDescription");
  const webSpeechMode = recognitionMode === "web-speech";
  const desktopStreamingMode = desktopStreaming && !webSpeechMode;
  const audioPipelineInactive = webSpeechMode || desktopStreamingMode;
  const deviceControlsDisabled = captureStarting || webSpeechMode;
  const audioPipelineControlsDisabled = captureStarting || audioPipelineInactive;
  const audioPipelineHint = (hint: string): string =>
    audioPipelineInactive ? `${hint} ${t("live.pipelineInactive")}` : hint;
  const silenceGateMode = resolveSilenceGateMode(config.audio.adaptiveNoiseFloor);
  const adaptiveNoiseFloorEnabled = silenceGateMode === "adaptive";
  const inputDeviceHint = webSpeechMode
    ? `${t("settings.deviceHint")} ${t("settings.webSpeechDeviceHint")}`
    : t("settings.deviceHint");
  const resetAudioTuning = () =>
    setAudio({
      chunkMs: DEFAULT_AUDIO_CHUNK_MS,
      vadIntervalMs: DEFAULT_VAD_INTERVAL_MS,
      vadThreshold: DEFAULT_VAD_THRESHOLD,
      silenceGateDb: DEFAULT_SILENCE_GATE_DB,
      adaptiveNoiseFloor: DEFAULT_ADAPTIVE_NOISE_FLOOR,
    });
  const setModelPath = (key: string, value: string) => {
    const paths = { ...config.models.paths };
    if (value.trim()) {
      paths[key] = value;
    } else {
      delete paths[key];
    }
    onConfigChange({ ...config, models: { ...config.models, paths } });
  };
  const [settingsPane, setSettingsPane] = useState<"everyday" | "advanced">("everyday");
  const recognitionModeField = (
    <Field
      label={t("settings.recognitionMode")}
      hint={`${t("settings.recognitionModeHint")} ${recognitionModeDescription}`}
    >
      <select
        id="recognition-mode"
        name="recognitionMode"
        data-testid="recognition-mode-select"
        value={recognitionMode}
        onChange={(event) =>
          onConfigChange({
            ...config,
            recognitionMode: event.target.value as RecognitionMode,
          })
        }
        aria-label={t("settings.recognitionMode")}
        disabled={captureStarting}
      >
        <option value="parapper-raw" title={t("settings.recognitionModeParapperRawDescription")}>
          {t("settings.recognitionModeParapperRaw")}
        </option>
        <option
          value="web-speech"
          title={
            webSpeechSupported
              ? t("settings.recognitionModeWebSpeechDescription")
              : t("settings.recognitionModeWebSpeechUnavailable")
          }
          disabled={!webSpeechSupported}
        >
          {t("settings.recognitionModeWebSpeech")}
        </option>
        <option
          value="parapper-azookey"
          title={t("settings.recognitionModeParapperAzookeyDescription")}
        >
          {t("settings.recognitionModeParapperAzookey")}
        </option>
      </select>
    </Field>
  );
  const languageFields = (
    <>
      <Field label={t("settings.sourceLanguage")} hint={t("settings.sourceLanguageHint")}>
        <input
          value={config.language.source}
          onChange={(event) =>
            onConfigChange({
              ...config,
              language: { ...config.language, source: event.target.value },
            })
          }
        />
      </Field>
      <Field label={t("settings.targetLanguage")}>
        <input
          value={config.language.target}
          onChange={(event) =>
            onConfigChange({
              ...config,
              language: { ...config.language, target: event.target.value },
            })
          }
        />
      </Field>
    </>
  );
  const deviceFields = (
    <fieldset
      className="audio-device-controls"
      data-testid="audio-device-controls"
      disabled={deviceControlsDisabled}
      aria-disabled={deviceControlsDisabled}
      style={{ display: "contents" }}
    >
      <Field label={t("audio.inputDevice")} wide hint={inputDeviceHint}>
        <AudioDeviceSelect
          devices={devices}
          value={config.audio.inputDeviceId}
          onChange={onDeviceChange}
          disabled={deviceControlsDisabled}
        />
      </Field>
      <div className="field button-field">
        <span>&nbsp;</span>
        <button
          className="secondary-button"
          type="button"
          onClick={onRefreshDevices}
          data-testid="audio-device-refresh"
          disabled={deviceControlsDisabled}
          title={webSpeechMode ? t("settings.webSpeechDeviceHint") : undefined}
        >
          {t("audio.refreshShort")}
        </button>
      </div>
    </fieldset>
  );

  return (
    <>
      <div className="content-heading">
        <div className="content-heading-title">
          <h2>{t("settings.title")}</h2>
          <div className="build-meta" data-testid="build-info">
            <span data-testid="build-version">v{BUILD_INFO.appVersion}</span>
            <span aria-hidden="true">·</span>
            <span data-testid="build-id">build {BUILD_INFO.buildId}</span>
          </div>
        </div>
        <div className="heading-actions">
          <div className="settings-pane-tabs" role="tablist" aria-label={t("settings.panes")}>
            <button
              type="button"
              role="tab"
              className={settingsPane === "everyday" ? "active" : ""}
              aria-selected={settingsPane === "everyday"}
              data-testid="settings-everyday-tab"
              onClick={() => setSettingsPane("everyday")}
            >
              {t("settings.everyday")}
            </button>
            <button
              type="button"
              role="tab"
              className={settingsPane === "advanced" ? "active" : ""}
              aria-selected={settingsPane === "advanced"}
              data-testid="settings-advanced-tab"
              onClick={() => setSettingsPane("advanced")}
            >
              {t("settings.advanced")}
            </button>
          </div>
          <button className="primary-button" type="button" onClick={onSave} disabled={saving}>
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
        </div>
      </div>

      <div
        hidden={settingsPane !== "everyday"}
        data-testid="settings-pane-everyday"
        role="tabpanel"
      >
        <section className="panel settings-section">
          <SectionHeading title={t("settings.everydayCaptureTitle")} />
          <div className="settings-grid two">
            {recognitionModeField}
            {languageFields}
            {deviceFields}
          </div>
        </section>
        <section className="panel settings-section">
          <SectionHeading title={t("settings.everydayOutputTitle")} />
          <div className="settings-grid two">
            <Field label={t("settings.nativeOutputLabel")} hint={t("settings.nativeOutputHint")}>
              <label className="checkbox-field">
                <input
                  id="overlay-native-output"
                  type="checkbox"
                  data-testid="native-output-enabled"
                  checked={config.overlay.nativeOutputEnabled ?? false}
                  onChange={(event) =>
                    setOverlay({ nativeOutputEnabled: event.currentTarget.checked })
                  }
                />
                <span>{t("settings.nativeOutputToggle")}</span>
              </label>
            </Field>
            <Field label={t("settings.order")}>
              <select
                value={config.overlay.order}
                onChange={(event) =>
                  setOverlay({ order: event.target.value as AppConfig["overlay"]["order"] })
                }
              >
                <option value="source-first">{t("settings.sourceFirst")}</option>
                <option value="translation-first">{t("settings.translationFirst")}</option>
              </select>
            </Field>
            <Field label={t("settings.width")}>
              <input
                type="number"
                min={OVERLAY_WIDTH_MIN_PX}
                max={OVERLAY_WIDTH_MAX_PX}
                step={OVERLAY_DIMENSION_STEP_PX}
                value={config.overlay.width}
                onChange={(event) => setOverlay({ width: Number(event.target.value) })}
              />
            </Field>
            <Field label={t("settings.height")}>
              <input
                type="number"
                min={OVERLAY_HEIGHT_MIN_PX}
                max={OVERLAY_HEIGHT_MAX_PX}
                step={OVERLAY_DIMENSION_STEP_PX}
                value={config.overlay.height}
                onChange={(event) => setOverlay({ height: Number(event.target.value) })}
              />
            </Field>
          </div>
          <div className="transparent-note">
            <strong>{t("settings.transparentTitle")}</strong>
            <small>{t("settings.transparentDetail")}</small>
          </div>
          {onOpenTransparentCapture || onCloseTransparentCapture ? (
            <div className="heading-actions">
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
            </div>
          ) : null}
        </section>
      </div>

      <div
        hidden={settingsPane !== "advanced"}
        data-testid="settings-pane-advanced"
        role="tabpanel"
      >
        <section className="panel settings-section">
          <SectionHeading title={t("settings.backendTitle")} />
          <div className="settings-grid two">
            <Field label={t("settings.backendMode")}>
              <select
                value={config.endpoint.mode}
                onChange={(event) =>
                  onConfigChange({
                    ...config,
                    endpoint: {
                      ...config.endpoint,
                      mode: event.target.value as AppConfig["endpoint"]["mode"],
                    },
                  })
                }
              >
                <option value="local">{t("settings.local")}</option>
                <option value="remote">{t("settings.remote")}</option>
              </select>
            </Field>
            <Field label={t("settings.timeout")}>
              <input
                type="number"
                min={ENDPOINT_TIMEOUT_MIN_MS}
                max={ENDPOINT_TIMEOUT_MAX_MS}
                step={ENDPOINT_TIMEOUT_STEP_MS}
                value={config.endpoint.timeoutMs}
                onChange={(event) =>
                  onConfigChange({
                    ...config,
                    endpoint: { ...config.endpoint, timeoutMs: Number(event.target.value) },
                  })
                }
              />
            </Field>
            <Field label={t("settings.gatewayUrl")} wide hint={t("settings.gatewayHint")}>
              <input
                value={config.endpoint.baseUrl}
                onChange={(event) =>
                  onConfigChange({
                    ...config,
                    endpoint: { ...config.endpoint, baseUrl: event.target.value },
                  })
                }
              />
            </Field>
          </div>
        </section>

        <section className="panel settings-section">
          <SectionHeading title={t("settings.modelsTitle")} />
          <div className="model-grid">
            <ModelCard
              family="asr"
              title={t("settings.asrModel")}
              config={config}
              models={models}
              onChange={(value) => onModelChange("asr", value)}
              onPathChange={setModelPath}
            />
            <ModelCard
              family="normalizer"
              title={t("settings.normalizerModel")}
              config={config}
              models={models}
              onChange={(value) => onModelChange("normalizer", value)}
              onPathChange={setModelPath}
            />
            <ModelCard
              family="translator"
              title={t("settings.translatorModel")}
              config={config}
              models={models}
              onChange={(value) => onModelChange("translator", value)}
              onPathChange={setModelPath}
            />
          </div>
          <p className="section-note">{t("settings.modelsNote")}</p>
          <Field label={t("settings.rescoreLabel")} hint={t("settings.rescoreHint")}>
            <label className="checkbox-field">
              <input
                id="rescore-enabled"
                type="checkbox"
                data-testid="rescore-enabled"
                checked={config.rescore.enabled}
                onChange={(event) => setRescore({ enabled: event.currentTarget.checked })}
              />
              <span>{t("settings.rescoreLabel")}</span>
            </label>
          </Field>
        </section>

        <ModelManagementCard />

        <section className="panel settings-section">
          <SectionHeading title={t("settings.audioTitle")} />
          <div className="settings-section-actions">
            <span>{t("settings.audioPipelineHint")}</span>
            <button
              className="secondary-button"
              type="button"
              onClick={resetAudioTuning}
              data-testid="audio-tuning-reset"
              disabled={audioPipelineControlsDisabled}
            >
              {t("settings.audioReset")}
            </button>
          </div>
          <div className="settings-grid two">
            <Field label={t("settings.chunk")} hint={audioPipelineHint(t("settings.chunkHint"))}>
              <div className="range-field">
                <input
                  id="audio-chunk-ms"
                  type="range"
                  min={AUDIO_CHUNK_MIN_MS}
                  max={AUDIO_CHUNK_MAX_MS}
                  step={AUDIO_CHUNK_STEP_MS}
                  value={config.audio.chunkMs}
                  onChange={(event) => setAudio({ chunkMs: event.currentTarget.valueAsNumber })}
                  aria-label={t("settings.chunk")}
                  disabled={audioPipelineControlsDisabled}
                  aria-valuetext={`${config.audio.chunkMs} ${t("settings.milliseconds")}`}
                />
                <output className="range-value" htmlFor="audio-chunk-ms">
                  {config.audio.chunkMs} {t("settings.milliseconds")}
                </output>
              </div>
              <button
                className="range-reset"
                type="button"
                onClick={() => setAudio({ chunkMs: DEFAULT_AUDIO_CHUNK_MS })}
                aria-label={`${t("settings.resetValue")}: ${t("settings.chunk")}`}
                disabled={audioPipelineControlsDisabled}
              >
                {t("settings.resetValue")}
              </button>
            </Field>
            <Field
              label={t("settings.silenceGate")}
              hint={audioPipelineHint(
                adaptiveNoiseFloorEnabled
                  ? `${t("settings.silenceGateHint")} ${t("settings.silenceGateAdaptiveDisabled")}`
                  : t("settings.silenceGateHint"),
              )}
            >
              <div className="range-field">
                <input
                  id="audio-silence-gate-db"
                  type="range"
                  min={SILENCE_GATE_MIN_DB}
                  max={SILENCE_GATE_MAX_DB}
                  step={SILENCE_GATE_STEP_DB}
                  value={config.audio.silenceGateDb}
                  onChange={(event) =>
                    setAudio({ silenceGateDb: event.currentTarget.valueAsNumber })
                  }
                  aria-label={t("settings.silenceGate")}
                  aria-valuetext={`${config.audio.silenceGateDb} ${t("settings.decibels")}${adaptiveNoiseFloorEnabled ? ` · ${t("settings.silenceGateAdaptiveLabel")}` : ""}`}
                  aria-disabled={adaptiveNoiseFloorEnabled || audioPipelineControlsDisabled}
                  disabled={adaptiveNoiseFloorEnabled || audioPipelineControlsDisabled}
                />
                <output className="range-value" htmlFor="audio-silence-gate-db">
                  {config.audio.silenceGateDb} {t("settings.decibels")}
                  {adaptiveNoiseFloorEnabled ? ` · ${t("settings.silenceGateAdaptiveLabel")}` : ""}
                </output>
              </div>
              <button
                className="range-reset"
                type="button"
                onClick={() => setAudio({ silenceGateDb: DEFAULT_SILENCE_GATE_DB })}
                aria-label={`${t("settings.resetValue")}: ${t("settings.silenceGate")}`}
                disabled={audioPipelineControlsDisabled}
              >
                {t("settings.resetValue")}
              </button>
            </Field>
            <Field
              label={t("settings.vadInterval")}
              hint={audioPipelineHint(t("settings.vadIntervalHint"))}
            >
              <div className="range-field">
                <input
                  id="audio-vad-interval-ms"
                  type="range"
                  min={VAD_INTERVAL_MIN_MS}
                  max={VAD_INTERVAL_MAX_MS}
                  step={VAD_INTERVAL_STEP_MS}
                  value={vadIntervalMs}
                  onChange={(event) =>
                    setAudio({ vadIntervalMs: event.currentTarget.valueAsNumber })
                  }
                  aria-label={t("settings.vadInterval")}
                  aria-valuetext={`${vadIntervalMs} ${t("settings.milliseconds")}`}
                  disabled={audioPipelineControlsDisabled}
                />
                <output className="range-value" htmlFor="audio-vad-interval-ms">
                  {vadIntervalMs} {t("settings.milliseconds")}
                </output>
              </div>
              <button
                className="range-reset"
                type="button"
                onClick={() => setAudio({ vadIntervalMs: DEFAULT_VAD_INTERVAL_MS })}
                aria-label={`${t("settings.resetValue")}: ${t("settings.vadInterval")}`}
                disabled={audioPipelineControlsDisabled}
              >
                {t("settings.resetValue")}
              </button>
            </Field>
            <Field
              label={t("settings.vadThreshold")}
              hint={audioPipelineHint(t("settings.vadThresholdHint"))}
            >
              <div className="range-field">
                <input
                  id="audio-vad-threshold"
                  type="range"
                  min={VAD_THRESHOLD_MIN}
                  max={VAD_THRESHOLD_MAX}
                  step={VAD_THRESHOLD_STEP}
                  value={vadThreshold}
                  onChange={(event) =>
                    setAudio({ vadThreshold: event.currentTarget.valueAsNumber })
                  }
                  aria-label={t("settings.vadThreshold")}
                  aria-valuetext={vadThreshold.toFixed(VAD_THRESHOLD_DECIMAL_PLACES)}
                  disabled={audioPipelineControlsDisabled}
                />
                <output className="range-value" htmlFor="audio-vad-threshold">
                  {vadThreshold.toFixed(VAD_THRESHOLD_DECIMAL_PLACES)}
                </output>
              </div>
              <button
                className="range-reset"
                type="button"
                onClick={() => setAudio({ vadThreshold: DEFAULT_VAD_THRESHOLD })}
                aria-label={`${t("settings.resetValue")}: ${t("settings.vadThreshold")}`}
                disabled={audioPipelineControlsDisabled}
              >
                {t("settings.resetValue")}
              </button>
            </Field>
            <Field
              label={t("settings.adaptiveNoiseFloor")}
              hint={audioPipelineHint(t("settings.adaptiveNoiseFloorHint"))}
            >
              <label className="checkbox-field">
                <input
                  id="audio-adaptive-noise-floor"
                  type="checkbox"
                  checked={config.audio.adaptiveNoiseFloor !== false}
                  onChange={(event) =>
                    setAudio({ adaptiveNoiseFloor: event.currentTarget.checked })
                  }
                  disabled={audioPipelineControlsDisabled}
                />
                <span>{t("settings.adaptiveNoiseFloorOn")}</span>
              </label>
            </Field>
            <Field
              label={t("settings.noiseSuppression")}
              hint={audioPipelineHint(t("settings.noiseSuppressionHint"))}
            >
              <label className="checkbox-field">
                <input
                  id="audio-noise-suppression"
                  type="checkbox"
                  checked={config.audio.noiseSuppression !== false}
                  onChange={(event) =>
                    onConfigChange({
                      ...config,
                      audio: { ...config.audio, noiseSuppression: event.target.checked },
                    })
                  }
                  disabled={audioPipelineControlsDisabled}
                />
                <span>{t("settings.noiseSuppressionOn")}</span>
              </label>
            </Field>
            <Field
              label={t("settings.streamingInterimAsr")}
              hint={t("settings.streamingInterimAsrHint")}
            >
              <label className="checkbox-field">
                <input
                  id="audio-streaming-interim-asr"
                  type="checkbox"
                  checked={config.audio.streamingInterimAsrEnabled !== false}
                  onChange={(event) =>
                    onConfigChange({
                      ...config,
                      audio: {
                        ...config.audio,
                        streamingInterimAsrEnabled: event.target.checked,
                      },
                    })
                  }
                />
                <span>{t("settings.streamingInterimAsrOn")}</span>
              </label>
            </Field>
            <Field
              label={t("settings.autoGainControl")}
              hint={audioPipelineHint(t("settings.autoGainControlHint"))}
            >
              <label className="checkbox-field">
                <input
                  id="audio-auto-gain-control"
                  type="checkbox"
                  checked={config.audio.autoGainControl !== false}
                  onChange={(event) =>
                    onConfigChange({
                      ...config,
                      audio: { ...config.audio, autoGainControl: event.target.checked },
                    })
                  }
                  disabled={audioPipelineControlsDisabled}
                />
                <span>{t("settings.autoGainControlOn")}</span>
              </label>
            </Field>
          </div>
        </section>

        <section className="panel settings-section">
          <SectionHeading title={t("settings.transparentTitle")} />
          <div className="settings-grid three">
            <Field label={t("settings.windowX")}>
              <input
                type="number"
                step={1}
                value={config.overlay.x}
                onChange={(event) => setOverlay({ x: Math.round(Number(event.target.value)) })}
              />
            </Field>
            <Field label={t("settings.windowY")}>
              <input
                type="number"
                step={1}
                value={config.overlay.y}
                onChange={(event) => setOverlay({ y: Math.round(Number(event.target.value)) })}
              />
            </Field>
            <Field
              label={t("settings.browserSourceLabel")}
              hint={
                (config.overlay.browserSource?.enabled ?? false)
                  ? t("settings.browserSourceUrl", {
                      port: config.overlay.browserSource?.port ?? DEFAULT_BROWSER_SOURCE_PORT,
                    })
                  : t("settings.browserSourceHint")
              }
            >
              <label className="checkbox-field">
                <input
                  id="overlay-browser-source"
                  type="checkbox"
                  checked={config.overlay.browserSource?.enabled ?? false}
                  onChange={(event) =>
                    setOverlay({
                      browserSource: {
                        enabled: event.currentTarget.checked,
                        port: config.overlay.browserSource?.port ?? DEFAULT_BROWSER_SOURCE_PORT,
                      },
                    })
                  }
                />
                <span>{t("settings.browserSourceToggle")}</span>
              </label>
            </Field>
            <Field label={t("settings.browserSourcePort")}>
              <input
                type="number"
                min={BROWSER_SOURCE_PORT_MIN}
                max={BROWSER_SOURCE_PORT_MAX}
                value={config.overlay.browserSource?.port ?? DEFAULT_BROWSER_SOURCE_PORT}
                onChange={(event) =>
                  setOverlay({
                    browserSource: {
                      enabled: config.overlay.browserSource?.enabled ?? false,
                      port: Number(event.target.value),
                    },
                  })
                }
              />
            </Field>
          </div>
        </section>

        <DebugPanel />
      </div>
    </>
  );
};
