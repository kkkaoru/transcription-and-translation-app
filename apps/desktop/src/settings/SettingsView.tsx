import type { ChangeEvent } from "react";
import { AudioDeviceSelect } from "../components/AudioDeviceSelect";
import { Field } from "../components/Field";
import {
  AUDIO_CHUNK_MAX_MS,
  AUDIO_CHUNK_MIN_MS,
  AUDIO_CHUNK_STEP_MS,
  CAPTION_POSITION_MAX_PERCENT,
  CAPTION_POSITION_MIN_PERCENT,
  DEFAULT_ADAPTIVE_NOISE_FLOOR,
  DEFAULT_AUDIO_CHUNK_MS,
  DEFAULT_RECOGNITION_MODE,
  DEFAULT_SILENCE_GATE_DB,
  DEFAULT_VAD_INTERVAL_MS,
  DEFAULT_VAD_THRESHOLD,
  ENDPOINT_TIMEOUT_MAX_MS,
  ENDPOINT_TIMEOUT_MIN_MS,
  ENDPOINT_TIMEOUT_STEP_MS,
  isRecognitionMode,
  OVERLAY_DIMENSION_STEP_PX,
  OVERLAY_GAP_MAX_PX,
  OVERLAY_GAP_MIN_PX,
  OVERLAY_HEIGHT_MAX_PX,
  OVERLAY_HEIGHT_MIN_PX,
  OVERLAY_SAFE_AREA_MAX_PX,
  OVERLAY_SAFE_AREA_MIN_PX,
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
import { TextStyleEditor } from "./TextStyleEditor";

const SectionHeading = ({
  eyebrow,
  title,
  number,
}: {
  eyebrow: string;
  title: string;
  number: string;
}) => (
  <div className="section-heading">
    <div>
      <span className="eyebrow">{eyebrow}</span>
      <h3>{title}</h3>
    </div>
    <span className="section-number">{number}</span>
  </div>
);

export const SettingsView = ({
  config,
  models,
  devices,
  saving,
  onConfigChange,
  onModelChange,
  onDeviceChange,
  onRefreshDevices,
  onSave,
  webSpeechSupported = isWebSpeechRecognitionSupported(),
}: {
  config: AppConfig;
  models: ModelCatalog;
  devices: AudioInputDevice[];
  saving: boolean;
  onConfigChange: (next: AppConfig) => void;
  onModelChange: (family: ModelFamily, value: string) => void;
  onDeviceChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onRefreshDevices: () => void;
  onSave: () => void;
  webSpeechSupported?: boolean;
}) => {
  const { t } = useI18n();
  const setOverlay = (patch: Partial<AppConfig["overlay"]>) =>
    onConfigChange({ ...config, overlay: { ...config.overlay, ...patch } });
  const setAudio = (patch: Partial<AppConfig["audio"]>) =>
    onConfigChange({ ...config, audio: { ...config.audio, ...patch } });
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

  return (
    <>
      <div className="content-heading">
        <div>
          <span className="eyebrow">{t("settings.eyebrow")}</span>
          <h2>{t("settings.title")}</h2>
        </div>
        <button className="primary-button" type="button" onClick={onSave} disabled={saving}>
          {saving ? t("settings.saving") : t("settings.save")}
        </button>
      </div>

      <section className="panel settings-section">
        <SectionHeading
          eyebrow={t("settings.languageEyebrow")}
          title={t("settings.languageTitle")}
          number="01"
        />
        <div className="settings-grid two">
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
            >
              <option
                value="parapper-raw"
                title={t("settings.recognitionModeParapperRawDescription")}
              >
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
        </div>
      </section>

      <section className="panel settings-section">
        <SectionHeading
          eyebrow={t("settings.modelsEyebrow")}
          title={t("settings.modelsTitle")}
          number="02"
        />
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
      </section>

      <ModelManagementCard />

      <section className="panel settings-section">
        <SectionHeading
          eyebrow={t("settings.audioEyebrow")}
          title={t("settings.audioTitle")}
          number="03"
        />
        <div className="settings-section-actions">
          <span>{t("settings.audioPipelineHint")}</span>
          <button
            className="secondary-button"
            type="button"
            onClick={resetAudioTuning}
            data-testid="audio-tuning-reset"
          >
            {t("settings.audioReset")}
          </button>
        </div>
        <div className="settings-grid two">
          <fieldset
            className="audio-device-controls"
            data-testid="audio-device-controls"
            disabled={webSpeechMode}
            aria-disabled={webSpeechMode}
            style={{ display: "contents" }}
          >
            <Field label={t("audio.inputDevice")} wide hint={inputDeviceHint}>
              <AudioDeviceSelect
                devices={devices}
                value={config.audio.inputDeviceId}
                onChange={onDeviceChange}
                disabled={webSpeechMode}
              />
            </Field>
            <div className="field button-field">
              <span>&nbsp;</span>
              <button
                className="secondary-button"
                type="button"
                onClick={onRefreshDevices}
                data-testid="audio-device-refresh"
                disabled={webSpeechMode}
                title={webSpeechMode ? t("settings.webSpeechDeviceHint") : undefined}
              >
                {t("audio.refreshShort")}
              </button>
            </div>
          </fieldset>
          <Field label={t("settings.chunk")} hint={t("settings.chunkHint")}>
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
            >
              {t("settings.resetValue")}
            </button>
          </Field>
          <Field
            label={t("settings.silenceGate")}
            hint={
              adaptiveNoiseFloorEnabled
                ? `${t("settings.silenceGateHint")} ${t("settings.silenceGateAdaptiveDisabled")}`
                : t("settings.silenceGateHint")
            }
          >
            <div className="range-field">
              <input
                id="audio-silence-gate-db"
                type="range"
                min={SILENCE_GATE_MIN_DB}
                max={SILENCE_GATE_MAX_DB}
                step={SILENCE_GATE_STEP_DB}
                value={config.audio.silenceGateDb}
                onChange={(event) => setAudio({ silenceGateDb: event.currentTarget.valueAsNumber })}
                aria-label={t("settings.silenceGate")}
                aria-valuetext={`${config.audio.silenceGateDb} ${t("settings.decibels")}${adaptiveNoiseFloorEnabled ? ` · ${t("settings.silenceGateAdaptiveLabel")}` : ""}`}
                aria-disabled={adaptiveNoiseFloorEnabled}
                disabled={adaptiveNoiseFloorEnabled}
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
            >
              {t("settings.resetValue")}
            </button>
          </Field>
          <Field label={t("settings.vadInterval")} hint={t("settings.vadIntervalHint")}>
            <div className="range-field">
              <input
                id="audio-vad-interval-ms"
                type="range"
                min={VAD_INTERVAL_MIN_MS}
                max={VAD_INTERVAL_MAX_MS}
                step={VAD_INTERVAL_STEP_MS}
                value={vadIntervalMs}
                onChange={(event) => setAudio({ vadIntervalMs: event.currentTarget.valueAsNumber })}
                aria-label={t("settings.vadInterval")}
                aria-valuetext={`${vadIntervalMs} ${t("settings.milliseconds")}`}
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
            >
              {t("settings.resetValue")}
            </button>
          </Field>
          <Field label={t("settings.vadThreshold")} hint={t("settings.vadThresholdHint")}>
            <div className="range-field">
              <input
                id="audio-vad-threshold"
                type="range"
                min={VAD_THRESHOLD_MIN}
                max={VAD_THRESHOLD_MAX}
                step={VAD_THRESHOLD_STEP}
                value={vadThreshold}
                onChange={(event) => setAudio({ vadThreshold: event.currentTarget.valueAsNumber })}
                aria-label={t("settings.vadThreshold")}
                aria-valuetext={vadThreshold.toFixed(VAD_THRESHOLD_DECIMAL_PLACES)}
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
            >
              {t("settings.resetValue")}
            </button>
          </Field>
          <Field
            label={t("settings.adaptiveNoiseFloor")}
            hint={t("settings.adaptiveNoiseFloorHint")}
          >
            <label className="checkbox-field">
              <input
                id="audio-adaptive-noise-floor"
                type="checkbox"
                checked={config.audio.adaptiveNoiseFloor !== false}
                onChange={(event) => setAudio({ adaptiveNoiseFloor: event.currentTarget.checked })}
              />
              <span>{t("settings.adaptiveNoiseFloorOn")}</span>
            </label>
          </Field>
          <Field label={t("settings.noiseSuppression")} hint={t("settings.noiseSuppressionHint")}>
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
              />
              <span>{t("settings.noiseSuppressionOn")}</span>
            </label>
          </Field>
        </div>
      </section>

      <section className="panel settings-section">
        <SectionHeading
          eyebrow={t("settings.overlayEyebrow")}
          title={t("settings.overlayTitle")}
          number="04"
        />
        <div className="settings-grid three">
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
          <Field label={t("settings.lineGap")}>
            <input
              type="number"
              min={OVERLAY_GAP_MIN_PX}
              max={OVERLAY_GAP_MAX_PX}
              value={config.overlay.gapPx}
              onChange={(event) => setOverlay({ gapPx: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.safeArea")}>
            <input
              type="number"
              min={OVERLAY_SAFE_AREA_MIN_PX}
              max={OVERLAY_SAFE_AREA_MAX_PX}
              value={config.overlay.safeAreaPx}
              onChange={(event) => setOverlay({ safeAreaPx: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.captionX")} hint={t("settings.captionXHint")}>
            <input
              type="number"
              min={CAPTION_POSITION_MIN_PERCENT}
              max={CAPTION_POSITION_MAX_PERCENT}
              value={config.overlay.captionXPercent}
              onChange={(event) => setOverlay({ captionXPercent: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.captionY")} hint={t("settings.captionYHint")}>
            <input
              type="number"
              min={CAPTION_POSITION_MIN_PERCENT}
              max={CAPTION_POSITION_MAX_PERCENT}
              value={config.overlay.captionYPercent}
              onChange={(event) => setOverlay({ captionYPercent: Number(event.target.value) })}
            />
          </Field>
        </div>
        <div className="style-editors">
          <TextStyleEditor
            config={config}
            kind="source"
            title={t("settings.sourceStyle")}
            onChange={onConfigChange}
          />
          <TextStyleEditor
            config={config}
            kind="translation"
            title={t("settings.translationStyle")}
            onChange={onConfigChange}
          />
        </div>
        <div className="transparent-note">
          <span className="green-dot" />
          <div>
            <strong>{t("settings.transparentTitle")}</strong>
            <small>{t("settings.transparentDetail")}</small>
          </div>
          <span className="auto-chip">{t("settings.autoOutput")}</span>
        </div>
      </section>

      <DebugPanel />
    </>
  );
};
