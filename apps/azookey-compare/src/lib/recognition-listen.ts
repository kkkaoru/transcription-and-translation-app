import type { RecognitionProvider } from "./contract";

export const BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX =
  "ブラウザ辞書の先行読み込みに失敗しました: ";

export const recognitionErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim() ? error.message : "予期しないエラーが発生しました";

export type BeginRecognitionListeningOptions = {
  provider: RecognitionProvider;
  start: () => void | Promise<void>;
  warmBrowserVibrato: () => Promise<void>;
  onWarmupNotice?: (message: string) => void;
  onWarmupError?: (message: string) => void;
  /** Web Speech + browser-vibrato: warmup failure blocks start. */
  requireVibratoWarmup?: boolean;
};

/**
 * Start recognition. Workers AI ASR never waits on dictionary warmup:
 * the mic must begin even if IPADIC/Zenzai warmup fails (notice only).
 */
const rethrowAsPageError = (caught: unknown): void => {
  const error = caught instanceof Error ? caught : new Error(recognitionErrorMessage(caught));
  console.error(error);
  queueMicrotask(() => {
    throw error;
  });
};

export const beginRecognitionListening = (options: BeginRecognitionListeningOptions): void => {
  if (options.provider === "workers-ai-asr") {
    void Promise.resolve(options.start()).catch(rethrowAsPageError);
    void options.warmBrowserVibrato().catch((caught: unknown) => {
      options.onWarmupNotice?.(
        `${BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX}${recognitionErrorMessage(caught)}`,
      );
    });
    return;
  }

  void options
    .warmBrowserVibrato()
    .then(() => {
      void options.start();
    })
    .catch((caught: unknown) => {
      if (options.requireVibratoWarmup) {
        options.onWarmupError?.(recognitionErrorMessage(caught));
        return;
      }
      options.onWarmupNotice?.(
        `${BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX}${recognitionErrorMessage(caught)}`,
      );
      void options.start();
    });
};
