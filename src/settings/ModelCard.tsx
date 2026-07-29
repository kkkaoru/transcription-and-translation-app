import { Field } from "../components/Field";
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
    description: "model.zenzXsmall.description",
  },
  "zenz-v3.2-small-gguf": {
    description: "model.zenzSmall.description",
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
  const selectedArtifact =
    localized?.artifact && selected ? t(localized.artifact) : selected?.localArtifact;

  return (
    <div className="model-card">
      <div className="model-card-heading">
        <div>
          <span className="eyebrow">{family.toUpperCase()}</span>
          <h3>{title}</h3>
        </div>
        <span className="model-chip">{selected?.id ?? t("common.notSelected")}</span>
      </div>
      <select value={config.models[family]} onChange={(event) => onChange(event.target.value)}>
        {models[family].map((entry) => {
          const copy = modelCopy[entry.id];
          const label = copy?.label ? t(copy.label) : entry.label;
          return (
            <option value={entry.id} key={entry.id}>
              {label}
              {entry.recommended ? ` · ${t("common.recommended")}` : ""}
            </option>
          );
        })}
      </select>
      <p>{selectedDescription}</p>
      {family !== "asr" ? (
        <Field label={t("settings.modelPath")} wide hint={selectedArtifact}>
          <input
            placeholder={t("settings.modelPathPlaceholder")}
            value={config.models.paths[config.models[family]] ?? ""}
            onChange={(event) => onPathChange(config.models[family], event.target.value)}
          />
        </Field>
      ) : null}
      {family === "normalizer" && config.models.normalizer === "azookey-rust" ? (
        <>
          <Field
            label={t("settings.azooUserDictionary")}
            wide
            hint={t("settings.azooUserDictionaryHint")}
          >
            <input
              placeholder={t("settings.azooPathPlaceholder")}
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
              value={config.models.paths["azookey-learning-memory"] ?? ""}
              onChange={(event) => onPathChange("azookey-learning-memory", event.target.value)}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
};
