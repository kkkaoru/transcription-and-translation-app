import { useState } from "react";
import { Field } from "../components/Field";
import {
  type AzooKeySystemDictionarySource,
  OFFICIAL_AZOOKEY_DICTIONARY_URL,
  pathForAzooKeySystemDictionarySource,
  resolveAzooKeySystemDictionarySource,
} from "../core/azookey-dictionary";
import type { AppConfig, ModelCatalog, ModelFamily } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";

const modelCopy: Partial<
  Record<
    string,
    {
      artifact?: MessageKey;
      description?: MessageKey;
      label?: MessageKey;
    }
  >
> = {
  "parapper-ja": {
    label: "model.parapper.label",
    description: "model.parapper.description",
  },
  "azookey-rust": {
    label: "model.azookey.label",
    description: "model.azookey.description",
    artifact: "model.azookey.artifact",
  },
  "zenz-v3.2-xsmall-gguf": {
    label: "model.zenzXsmall.label",
    description: "model.zenzXsmall.description",
  },
  "zenz-v3.2-small-gguf": {
    label: "model.zenzSmall.label",
    description: "model.zenzSmall.description",
  },
  "zenz-v2-q5-k-m-gguf": {
    label: "model.zenzV2.label",
    description: "model.zenzV2.description",
  },
  "hy-mt2-1.8b-gguf": {
    description: "model.hy18.description",
  },
  "hy-mt2-1.8b-2bit-gguf": {
    description: "model.hy2bit.description",
  },
  "hy-mt2-1.8b-1.25bit-gguf": {
    description: "model.hy125bit.description",
  },
  "hy-mt2-7b-gguf": {
    description: "model.hy7b.description",
  },
};

export const ModelCard = ({
  family,
  title,
  config,
  models,
  onChange,
  onPathChange,
}: {
  family: ModelFamily;
  title: string;
  config: AppConfig;
  models: ModelCatalog;
  onChange: (value: string) => void;
  onPathChange: (key: string, value: string) => void;
}) => {
  const { t } = useI18n();
  const selected = models[family].find((entry) => entry.id === config.models[family]);
  const localized = selected ? modelCopy[selected.id] : undefined;
  const selectedDescription =
    localized?.description && selected ? t(localized.description) : selected?.description;
  const selectedLabel = selected
    ? localized?.label
      ? t(localized.label)
      : selected.label
    : undefined;
  const selectedTitle = selectedLabel
    ? `${selectedLabel}${selected?.recommended ? ` · ${t("common.recommended")}` : ""}`
    : undefined;
  const systemDictionaryPath = config.models.paths["azookey-rust"] ?? "";
  const derivedSystemDictionarySource = resolveAzooKeySystemDictionarySource(systemDictionaryPath);
  // Empty path means builtin for the pipeline, but the UI must still stay on
  // "custom" after the user picks that preset so they can type a path/URL.
  const [customSourceUnlocked, setCustomSourceUnlocked] = useState(false);
  const systemDictionarySource: AzooKeySystemDictionarySource =
    customSourceUnlocked && derivedSystemDictionarySource === "builtin"
      ? "custom"
      : derivedSystemDictionarySource;
  const showAzooKeyDictionaryFields =
    family === "normalizer" && config.models.normalizer === "azookey-rust";
  const [customSystemDictionaryDraft, setCustomSystemDictionaryDraft] = useState(() =>
    derivedSystemDictionarySource === "custom" ? systemDictionaryPath : "",
  );

  return (
    <div className="model-card">
      <div className="model-card-heading">
        <div>
          <h3>{title}</h3>
        </div>
        <span className="model-chip">{selected?.id ?? t("common.notSelected")}</span>
      </div>
      <select
        value={config.models[family]}
        title={selectedTitle}
        data-testid={`${family}-model-select`}
        aria-label={title}
        onChange={(event) => onChange(event.target.value)}
      >
        {models[family].map((entry) => {
          const copy = modelCopy[entry.id];
          const label = copy?.label ? t(copy.label) : entry.label;
          // Keep the closed <select> readable in multi-column cards: full "· Recommended"
          // truncates mid-word ("Recommende") at ~340px. Star marks recommended models.
          const optionTitle = entry.recommended ? `${label} · ${t("common.recommended")}` : label;
          return (
            <option value={entry.id} key={entry.id} title={optionTitle}>
              {label}
              {entry.recommended ? " ★" : ""}
            </option>
          );
        })}
      </select>
      {selected?.recommended ? (
        <p className="model-recommended-hint">{t("common.recommended")}</p>
      ) : null}
      <p>{selectedDescription}</p>
      {showAzooKeyDictionaryFields ? (
        <>
          <Field
            label={t("settings.azooSystemDictionarySource")}
            wide
            hint={t("settings.azooSystemDictionarySourceHint")}
          >
            <select
              id="azookey-system-dictionary-source"
              data-testid="azookey-system-dictionary-source"
              aria-label={t("settings.azooSystemDictionarySource")}
              value={systemDictionarySource}
              onChange={(event) => {
                const next = event.currentTarget.value as AzooKeySystemDictionarySource;
                if (systemDictionarySource === "custom") {
                  setCustomSystemDictionaryDraft(systemDictionaryPath);
                }
                setCustomSourceUnlocked(next === "custom");
                onPathChange(
                  "azookey-rust",
                  pathForAzooKeySystemDictionarySource(
                    next,
                    next === "custom" ? customSystemDictionaryDraft : systemDictionaryPath,
                  ),
                );
              }}
            >
              <option value="builtin">{t("settings.azooSystemDictionaryBuiltin")}</option>
              <option value="official">{t("settings.azooSystemDictionaryOfficial")}</option>
              <option value="custom">{t("settings.azooSystemDictionaryCustom")}</option>
            </select>
          </Field>
          {systemDictionarySource === "official" ? (
            <p className="section-note" data-testid="azookey-system-dictionary-official-url">
              {OFFICIAL_AZOOKEY_DICTIONARY_URL}
            </p>
          ) : null}
          {systemDictionarySource === "custom" ? (
            <Field
              label={t("settings.azooSystemDictionary")}
              wide
              hint={t("settings.azooSystemDictionaryHint")}
            >
              <input
                data-testid="azookey-system-dictionary-path"
                placeholder={t("settings.azooPathPlaceholder")}
                title={systemDictionaryPath.trim() || t("settings.azooPathPlaceholder")}
                value={systemDictionaryPath}
                onChange={(event) => {
                  const nextPath = event.target.value;
                  setCustomSystemDictionaryDraft(nextPath);
                  setCustomSourceUnlocked(true);
                  onPathChange("azookey-rust", nextPath);
                }}
              />
            </Field>
          ) : null}
          <Field
            label={t("settings.azooUserDictionary")}
            wide
            hint={t("settings.azooUserDictionaryHint")}
          >
            <input
              placeholder={t("settings.azooPathPlaceholder")}
              title={
                config.models.paths["azookey-user-dictionary"]?.trim() ||
                t("settings.azooPathPlaceholder")
              }
              value={config.models.paths["azookey-user-dictionary"] ?? ""}
              onChange={(event) => onPathChange("azookey-user-dictionary", event.target.value)}
            />
          </Field>
          <Field
            label={t("settings.azooLearningMemory")}
            wide
            hint={t("settings.azooLearningMemoryHint")}
          >
            <input
              placeholder={t("settings.azooPathPlaceholder")}
              title={
                config.models.paths["azookey-learning-memory"]?.trim() ||
                t("settings.azooPathPlaceholder")
              }
              value={config.models.paths["azookey-learning-memory"] ?? ""}
              onChange={(event) => onPathChange("azookey-learning-memory", event.target.value)}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
};
