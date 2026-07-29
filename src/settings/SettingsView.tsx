import type { ChangeEvent } from "react";
import { AudioDeviceSelect } from "../components/AudioDeviceSelect";
import { Field } from "../components/Field";
import type { AppConfig, AudioInputDevice, ModelCatalog, ModelFamily } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import { ModelCard } from "./ModelCard";
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
}) => {
  const { t } = useI18n();
  const setOverlay = (patch: Partial<AppConfig["overlay"]>) =>
    onConfigChange({ ...config, overlay: { ...config.overlay, ...patch } });
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
              min="1000"
              max="120000"
              step="1000"
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

      <section className="panel settings-section">
        <SectionHeading
          eyebrow={t("settings.audioEyebrow")}
          title={t("settings.audioTitle")}
          number="03"
        />
        <div className="settings-grid two">
          <Field label={t("audio.inputDevice")} wide hint={t("settings.deviceHint")}>
            <AudioDeviceSelect
              devices={devices}
              value={config.audio.inputDeviceId}
              onChange={onDeviceChange}
            />
          </Field>
          <div className="field button-field">
            <span>&nbsp;</span>
            <button className="secondary-button" type="button" onClick={onRefreshDevices}>
              {t("audio.refreshShort")}
            </button>
          </div>
          <Field label={t("settings.chunk")} hint={t("settings.chunkHint")}>
            <input
              type="number"
              min="400"
              max="4000"
              step="100"
              value={config.audio.chunkMs}
              onChange={(event) =>
                onConfigChange({
                  ...config,
                  audio: { ...config.audio, chunkMs: Number(event.target.value) },
                })
              }
            />
          </Field>
          <Field label={t("settings.silenceGate")}>
            <input
              type="number"
              min="-90"
              max="0"
              step="1"
              value={config.audio.silenceGateDb}
              onChange={(event) =>
                onConfigChange({
                  ...config,
                  audio: { ...config.audio, silenceGateDb: Number(event.target.value) },
                })
              }
            />
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
              min="320"
              max="7680"
              step="1"
              value={config.overlay.width}
              onChange={(event) => setOverlay({ width: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.height")}>
            <input
              type="number"
              min="180"
              max="4320"
              step="1"
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
              min="0"
              max="160"
              value={config.overlay.gapPx}
              onChange={(event) => setOverlay({ gapPx: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.safeArea")}>
            <input
              type="number"
              min="0"
              max="400"
              value={config.overlay.safeAreaPx}
              onChange={(event) => setOverlay({ safeAreaPx: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.captionX")} hint={t("settings.captionXHint")}>
            <input
              type="number"
              min="0"
              max="100"
              value={config.overlay.captionXPercent}
              onChange={(event) => setOverlay({ captionXPercent: Number(event.target.value) })}
            />
          </Field>
          <Field label={t("settings.captionY")} hint={t("settings.captionYHint")}>
            <input
              type="number"
              min="0"
              max="100"
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
    </>
  );
};
