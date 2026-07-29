import type { AppConfig, CaptionPayload, CaptionTextStyle } from "../core/types";

export interface CaptionItem {
  key: "source" | "translation";
  text: string;
  style: CaptionTextStyle;
}

export const createPreviewCaption = (): CaptionPayload => {
  const now = Date.now();
  return {
    id: "preview",
    sourceText: "これはプレビュー用の字幕です。",
    translationText: "This is a preview caption.",
    sourceLanguage: "ja",
    targetLanguage: "en",
    startedAt: now,
    receivedAt: now,
  };
};

export const captionItems = (
  config: AppConfig,
  caption: CaptionPayload,
  placeholder = false,
): CaptionItem[] => {
  const source: CaptionItem = {
    key: "source",
    text: placeholder ? "日本語の音声認識結果がここに表示されます" : caption.sourceText,
    style: config.overlay.source,
  };
  const translation: CaptionItem = {
    key: "translation",
    text: placeholder ? "English translation will appear here" : caption.translationText,
    style: config.overlay.translation,
  };
  return config.overlay.order === "source-first" ? [source, translation] : [translation, source];
};
