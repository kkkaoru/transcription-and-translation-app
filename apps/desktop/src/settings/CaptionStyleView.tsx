import { Field } from "../components/Field";
import {
  CAPTION_MAX_CHARS_MAX,
  CAPTION_MAX_CHARS_MIN,
  CAPTION_POSITION_MAX_PERCENT,
  CAPTION_POSITION_MIN_PERCENT,
  clampCaptionMaxChars,
  OVERLAY_GAP_MAX_PX,
  OVERLAY_GAP_MIN_PX,
  OVERLAY_SAFE_AREA_MAX_PX,
  OVERLAY_SAFE_AREA_MIN_PX,
} from "../core/defaults";
import type { AppConfig } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import { resolveCaptionMaxChars } from "../overlay/captions";
import { TextStyleEditor } from "./TextStyleEditor";

export const CaptionStyleView = ({
  config,
  saving,
  onConfigChange,
  onSave,
}: {
  config: AppConfig;
  saving: boolean;
  onConfigChange: (next: AppConfig) => void;
  onSave: () => void;
}) => {
  const { t } = useI18n();
  const setOverlay = (patch: Partial<AppConfig["overlay"]>) =>
    onConfigChange({ ...config, overlay: { ...config.overlay, ...patch } });

  return (
    <>
      <div className="content-heading">
        <h2>{t("sidebar.style")}</h2>
        <div className="heading-actions">
          <button className="primary-button" type="button" onClick={onSave} disabled={saving}>
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
        </div>
      </div>

      <section className="panel settings-section" data-testid="caption-style-layout">
        <div className="section-heading">
          <h3>{t("settings.overlayTitle")}</h3>
        </div>
        <div className="settings-grid three">
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
          <Field label={t("settings.sourceMaxChars")} hint={t("settings.sourceMaxCharsHint")}>
            <input
              type="number"
              min={CAPTION_MAX_CHARS_MIN}
              max={CAPTION_MAX_CHARS_MAX}
              value={resolveCaptionMaxChars(config, "source")}
              onChange={(event) =>
                setOverlay({
                  captionMaxChars: {
                    source: clampCaptionMaxChars(Number(event.target.value), "source"),
                    translation: resolveCaptionMaxChars(config, "translation"),
                  },
                })
              }
            />
          </Field>
          <Field
            label={t("settings.translationMaxChars")}
            hint={t("settings.translationMaxCharsHint")}
          >
            <input
              type="number"
              min={CAPTION_MAX_CHARS_MIN}
              max={CAPTION_MAX_CHARS_MAX}
              value={resolveCaptionMaxChars(config, "translation")}
              onChange={(event) =>
                setOverlay({
                  captionMaxChars: {
                    source: resolveCaptionMaxChars(config, "source"),
                    translation: clampCaptionMaxChars(Number(event.target.value), "translation"),
                  },
                })
              }
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
      </section>

      <div className="style-editors" data-testid="caption-style-editors">
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
    </>
  );
};
