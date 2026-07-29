import type { AppConfig, CaptionTextStyle } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";

const updateTextStyle = (
  config: AppConfig,
  kind: "source" | "translation",
  key: keyof CaptionTextStyle,
  value: CaptionTextStyle[keyof CaptionTextStyle],
): AppConfig => ({
  ...config,
  overlay: {
    ...config.overlay,
    [kind]: {
      ...config.overlay[kind],
      [key]: value,
    },
  },
});

export const TextStyleEditor = ({
  config,
  kind,
  title,
  onChange,
}: {
  config: AppConfig;
  kind: "source" | "translation";
  title: string;
  onChange: (next: AppConfig) => void;
}) => {
  const { t } = useI18n();
  const style = config.overlay[kind];
  const set = <K extends keyof CaptionTextStyle>(key: K, value: CaptionTextStyle[K]) => {
    onChange(updateTextStyle(config, kind, key, value));
  };
  const number = (
    key: keyof CaptionTextStyle,
    labelKey: MessageKey,
    min: number,
    max: number,
    step: number,
  ) => (
    <label className="field compact" key={String(key)}>
      <span>{t(labelKey)}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(style[key])}
        onChange={(event) => set(key, Number(event.target.value) as CaptionTextStyle[typeof key])}
      />
    </label>
  );

  return (
    <details className="style-editor" open>
      <summary>{title}</summary>
      <div className="style-grid">
        <label className="field wide">
          <span>{t("style.fontFamily")}</span>
          <input
            value={style.fontFamily}
            onChange={(event) => set("fontFamily", event.target.value)}
          />
        </label>
        {number("fontSizePx", "style.fontSize", 8, 240, 1)}
        {number("fontWeight", "style.fontWeight", 100, 900, 50)}
        {number("letterSpacingPx", "style.letterSpacing", -10, 30, 0.1)}
        {number("lineHeight", "style.lineHeight", 0.8, 3, 0.05)}
        {number("maxWidthPercent", "style.maxWidth", 10, 100, 1)}
        {number("opacity", "style.opacity", 0, 1, 0.05)}
        <label className="field">
          <span>{t("style.textColor")}</span>
          <input
            type="color"
            value={style.color}
            onChange={(event) => set("color", event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("style.alignment")}</span>
          <select
            value={style.textAlign}
            onChange={(event) =>
              set("textAlign", event.target.value as CaptionTextStyle["textAlign"])
            }
          >
            <option value="left">{t("style.left")}</option>
            <option value="center">{t("style.center")}</option>
            <option value="right">{t("style.right")}</option>
          </select>
        </label>
      </div>
      <div className="style-subsection">
        <div className="subsection-title">{t("style.outlineSection")}</div>
        <div className="style-grid">
          <label className="toggle-field wide">
            <input
              type="checkbox"
              checked={style.cullingEnabled}
              onChange={(event) => set("cullingEnabled", event.target.checked)}
            />
            <span>{t("style.showOutline")}</span>
          </label>
          <label className="field">
            <span>{t("style.color")}</span>
            <input
              type="color"
              value={style.cullingColor}
              onChange={(event) => set("cullingColor", event.target.value)}
            />
          </label>
          {number("cullingWidthPx", "style.width", 0, 16, 0.5)}
          {number("cullingOpacity", "style.opacity", 0, 1, 0.05)}
        </div>
      </div>
      <div className="style-subsection">
        <div className="subsection-title">{t("style.shadowSection")}</div>
        <div className="style-grid">
          <label className="toggle-field wide">
            <input
              type="checkbox"
              checked={style.shadowEnabled}
              onChange={(event) => set("shadowEnabled", event.target.checked)}
            />
            <span>{t("style.showShadow")}</span>
          </label>
          <label className="field">
            <span>{t("style.shadowColor")}</span>
            <input
              type="color"
              value={style.shadowColor}
              onChange={(event) => set("shadowColor", event.target.value)}
            />
          </label>
          {number("shadowBlurPx", "style.blur", 0, 50, 1)}
          {number("shadowOffsetX", "style.shadowX", -40, 40, 1)}
          {number("shadowOffsetY", "style.shadowY", -40, 40, 1)}
          <label className="toggle-field wide">
            <input
              type="checkbox"
              checked={style.backgroundEnabled}
              onChange={(event) => set("backgroundEnabled", event.target.checked)}
            />
            <span>{t("style.showBackground")}</span>
          </label>
          <label className="field">
            <span>{t("style.backgroundColor")}</span>
            <input
              type="color"
              value={style.backgroundColor}
              onChange={(event) => set("backgroundColor", event.target.value)}
            />
          </label>
          {number("backgroundOpacity", "style.backgroundOpacity", 0, 1, 0.05)}
          {number("paddingX", "style.paddingX", 0, 100, 1)}
          {number("paddingY", "style.paddingY", 0, 100, 1)}
          {number("borderRadius", "style.borderRadius", 0, 100, 1)}
        </div>
      </div>
    </details>
  );
};
