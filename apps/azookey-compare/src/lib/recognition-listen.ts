// This file runs with bun.
import type { RecognitionProvider } from "./contract";

export const BROWSER_VIBRATO_WARMUP_FAILURE_NOTICE_PREFIX =
  "ブラウザ辞書の先行読み込みに失敗しました: ";

export const WORKER_ISOLATE_WARMUP_FAILURE_NOTICE_PREFIX =
  "Cloudflare Worker isolate の先行起動に失敗しました: ";

export const recognitionErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim() ? error.message : "予期しないエラーが発生しました";

export type BeginRecognitionListeningOptions = {
  provider: RecognitionProvider;
  start: () => void | Promise<void>;
  warmBrowserVibrato: () => Promise<void>;
  /**
   * Open/reuse `/ws/azookey` and GET `/v1/azookey` at speech start so the
   * Worker isolate is warm before the first final transcript.
   */
  warmWorkerIsolate?: () => Promise<void>;
  onWarmupNotice?: (message: string) => void;
  onWarmupError?: (message: string) => void;
  /** Web Speech + browser-vibrato: warmup failure blocks start. */
  requireVibratoWarmup?: boolean;
};

/**
 * Start recognition. Workers AI ASR never waits on dictionary warmup:
 * the mic must begin even if IPADIC/Zenzai warmup fails (notice only).
 * Isolate warmup is always fire-and-forget so the first caption is not
 * blocked on WASM + dictionary load.
 */
const logStartFailure = (caught: unknown): void => {
  const error = caught instanceof Error ? caught : new Error(recognitionErrorMessage(caught));
  // Tests assert start failures surface via console.error.
  // biome-ignore lint/suspicious/noConsole: intentional start-failure diagnostics for UI callers
  console.error(error);
};

const fireWorkerIsolateWarmup = (options: BeginRecognitionListeningOptions): void => {
  if (!options.warmWorkerIsolate) {
    return;
  }
  void options.warmWorkerIsolate().catch((caught: unknown) => {
    options.onWarmupNotice?.(
      `${WORKER_ISOLATE_WARMUP_FAILURE_NOTICE_PREFIX}${recognitionErrorMessage(caught)}`,
    );
  });
};

export const beginRecognitionListening = (options: BeginRecognitionListeningOptions): void => {
  fireWorkerIsolateWarmup(options);
  if (options.provider === "workers-ai-asr") {
    void Promise.resolve(options.start()).catch(logStartFailure);
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
