// This file runs with bun.
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Field } from "../components/Field";
import {
  type CaptionStylePreviewLines,
  captionForStylePreviewLines,
} from "../core/caption-style-preview";
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
import { computePreviewFitScale } from "../core/style";
import type { AppConfig } from "../core/types";
import { useI18n } from "../i18n/I18nProvider";
import { OverlayView } from "../overlay/CaptionOverlay";
import { createPreviewCaption, resolveCaptionMaxChars } from "../overlay/captions";
import { TextStyleEditor } from "./TextStyleEditor";

const DEFAULT_PREVIEW_CAPTION = createPreviewCaption();
const DEFAULT_PREVIEW_SOURCE_TEXT: string = DEFAULT_PREVIEW_CAPTION.sourceText;
const DEFAULT_PREVIEW_TRANSLATION_TEXT: string = DEFAULT_PREVIEW_CAPTION.translationText;
const DEFAULT_PREVIEW_BACKGROUND_COLOR: string = "#1a2830";

const CaptionStylePreview = ({ config }: { config: AppConfig }) => {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [previewLines, setPreviewLines] = useState<CaptionStylePreviewLines>(2);
  const [previewSourceText, setPreviewSourceText] = useState<string>(DEFAULT_PREVIEW_SOURCE_TEXT);
  const [previewTranslationText, setPreviewTranslationText] = useState<string>(
    DEFAULT_PREVIEW_TRANSLATION_TEXT,
  );
  const [previewBackgroundColor, setPreviewBackgroundColor] = useState<string>(
    DEFAULT_PREVIEW_BACKGROUND_COLOR,
  );
  const caption = useMemo(
    () =>
      captionForStylePreviewLines(
        {
          ...DEFAULT_PREVIEW_CAPTION,
          sourceText: previewSourceText,
          translationText: previewTranslationText,
        },
        previewLines,
      ),
    [previewLines, previewSourceText, previewTranslationText],
  );
  const overlayWidth = Number.isFinite(config.overlay.width)
    ? Math.max(1, config.overlay.width)
    : 1_280;
  const overlayHeight = Number.isFinite(config.overlay.height)
    ? Math.max(1, config.overlay.height)
    : 720;
  const measured = stageSize.width > 1 && stageSize.height > 1;
  const previewScale = measured
    ? computePreviewFitScale(stageSize.width, stageSize.height, overlayWidth, overlayHeight)
    : 1;
  const scaleHostStyle = useMemo<CSSProperties>(() => {
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
      if (entry) {
        applySize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(node);
    const rect = node.getBoundingClientRect();
    applySize(rect.width, rect.height);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="panel preview-panel" data-testid="caption-style-preview">
      <div className="panel-heading">
        <div>
          <h3>{t("settings.stylePreviewTitle")}</h3>
        </div>
        <fieldset className="preview-line-toggle">
          <legend className="visually-hidden">{t("settings.previewLines")}</legend>
          <button
            type="button"
            className={previewLines === 1 ? "active" : ""}
            aria-pressed={previewLines === 1}
            onClick={() => setPreviewLines(1)}
          >
            {t("settings.previewOneLine")}
          </button>
          <button
            type="button"
            className={previewLines === 2 ? "active" : ""}
            aria-pressed={previewLines === 2}
            onClick={() => setPreviewLines(2)}
          >
            {t("settings.previewTwoLines")}
          </button>
        </fieldset>
        <span className="live-badge">{t("settings.stylePreviewLive")}</span>
      </div>
      <div
        className="preview-stage"
        ref={stageRef}
        style={{
          aspectRatio: `${overlayWidth} / ${overlayHeight}`,
          backgroundColor: previewBackgroundColor,
        }}
        data-testid="caption-style-preview-stage"
        data-preview-measured={measured ? "true" : "false"}
        data-preview-scale={previewScale.toFixed(4)}
      >
        <div
          className={`preview-scale-host${measured ? " is-scaled" : " is-fill"}`}
          style={scaleHostStyle}
          data-testid="caption-style-preview-host"
        >
          <OverlayView config={config} caption={caption} preview placeholder={false} />
        </div>
      </div>
      <div className="preview-fields">
        <Field label={t("settings.previewSourceText")}>
          <input
            data-testid="caption-style-preview-source"
            type="text"
            value={previewSourceText}
            onChange={(event) => setPreviewSourceText(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("settings.previewTranslationText")}>
          <input
            data-testid="caption-style-preview-translation"
            type="text"
            value={previewTranslationText}
            onChange={(event) => setPreviewTranslationText(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("settings.previewBackgroundColor")}>
          <input
            data-testid="caption-style-preview-background"
            type="color"
            value={previewBackgroundColor}
            onChange={(event) => setPreviewBackgroundColor(event.currentTarget.value)}
          />
        </Field>
      </div>
      <div className="preview-footer">
        <span>{t("settings.stylePreviewHint")}</span>
      </div>
    </section>
  );
};

export const CaptionStyleView = ({
  config,
  saving,
  onConfigChange,
  onSave,
  showPreview = true,
}: {
  config: AppConfig;
  saving: boolean;
  onConfigChange: (next: AppConfig) => void;
  onSave: () => void;
  /** Keep the preview alongside the controls in both style surfaces by default. */
  showPreview?: boolean;
}) => {
  const { t } = useI18n();
  const setOverlay = (patch: Partial<AppConfig["overlay"]>) =>
    onConfigChange({ ...config, overlay: { ...config.overlay, ...patch } });

  const editor = (
    <>
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

      {showPreview ? (
        <div className="live-grid caption-style-workspace" data-testid="caption-style-workspace">
          <div className="caption-style-controls">{editor}</div>
          <CaptionStylePreview config={config} />
        </div>
      ) : (
        editor
      )}
    </>
  );
};
