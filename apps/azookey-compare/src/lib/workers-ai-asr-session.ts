import type { ComparisonAuth } from "./contract";
import { beginRecognitionListening } from "./recognition-listen";
import {
  WorkersAiAsrController,
  type WorkersAiAsrControllerOptions,
} from "./workers-ai-asr-controller";
import {
  getUserMediaErrorMessageJa,
  isWorkersAiAsrCaptureSupported,
  WORKERS_AI_ASR_PREPARING_JA,
  WORKERS_AI_ASR_UNSUPPORTED_JA,
} from "./workers-ai-asr-support";

export type EnsureWorkersAiAsrControllerParams = {
  language: string;
  endpointUrl?: string;
  auth?: ComparisonAuth;
  existing: WorkersAiAsrController | null;
  callbacks?: Omit<WorkersAiAsrControllerOptions, "language" | "endpointUrl" | "auth">;
  createController?: (
    language: string,
    options: WorkersAiAsrControllerOptions,
  ) => WorkersAiAsrController;
};

export type WorkersAiAsrStartGate =
  | { ok: true; controller: WorkersAiAsrController }
  | { ok: false; reason: "unsupported" | "preparing"; message: string };

const createDefaultController = (
  language: string,
  options: WorkersAiAsrControllerOptions,
): WorkersAiAsrController => new WorkersAiAsrController(language, options);

/**
 * Create or reuse the Workers AI ASR controller. Start must not wait for a
 * React effect tick after the provider select changes.
 */
export const ensureWorkersAiAsrController = (
  params: EnsureWorkersAiAsrControllerParams,
): WorkersAiAsrController => {
  const options: WorkersAiAsrControllerOptions = {
    language: params.language,
    endpointUrl: params.endpointUrl,
    auth: params.auth,
    ...params.callbacks,
  };
  if (
    params.existing &&
    !params.existing.isDisposed &&
    params.existing.matchesTransport(params.endpointUrl, params.auth)
  ) {
    params.existing.setLanguage(params.language);
    return params.existing;
  }
  params.existing?.dispose();
  const create = params.createController ?? createDefaultController;
  return create(params.language, options);
};

/**
 * Gate start(). A missing controller is 準備中, not “unsupported”.
 * Unsupported only when getUserMedia / AudioContext is actually unavailable.
 */
export const gateWorkersAiAsrStart = (options: {
  controller: WorkersAiAsrController | null;
  captureSupported?: boolean;
}): WorkersAiAsrStartGate => {
  if (!options.controller) {
    const captureSupported = options.captureSupported ?? isWorkersAiAsrCaptureSupported();
    if (!captureSupported) {
      return { ok: false, reason: "unsupported", message: WORKERS_AI_ASR_UNSUPPORTED_JA };
    }
    return { ok: false, reason: "preparing", message: WORKERS_AI_ASR_PREPARING_JA };
  }
  const captureSupported = options.captureSupported ?? options.controller.supported;
  if (!captureSupported || !options.controller.supported) {
    return { ok: false, reason: "unsupported", message: WORKERS_AI_ASR_UNSUPPORTED_JA };
  }
  return { ok: true, controller: options.controller };
};

export type StartCloudflareWorkersAiAsrAfterSelectParams = {
  language: string;
  endpointUrl?: string;
  auth?: ComparisonAuth;
  /** Null just after selecting workers-ai-asr, before the React effect mounts. */
  existing: WorkersAiAsrController | null;
  captureSupported?: boolean;
  callbacks?: Omit<WorkersAiAsrControllerOptions, "language" | "endpointUrl" | "auth">;
  createController?: EnsureWorkersAiAsrControllerParams["createController"];
  onError?: (message: string) => void;
  /**
   * Same Vibrato warmup the compare page toggleListening used to pass to
   * beginRecognitionListening. Workers AI ASR must start even if this rejects.
   */
  warmBrowserVibrato?: () => Promise<void>;
  onWarmupNotice?: (message: string) => void;
  requireVibratoWarmup?: boolean;
};

export type StartCloudflareWorkersAiAsrAfterSelectResult =
  | { ok: true; controller: WorkersAiAsrController }
  | {
      ok: false;
      reason: "unsupported" | "preparing" | "start-failed";
      message: string;
      controller: WorkersAiAsrController | null;
    };

/**
 * Same path as the compare page “認識を開始” button after selecting
 * Cloudflare Workers AI ASR: ensure → gate → start(), without waiting a
 * useEffect tick. Vibrato warmup runs in parallel and never blocks start.
 */
export const startCloudflareWorkersAiAsrAfterSelect = (
  params: StartCloudflareWorkersAiAsrAfterSelectParams,
): Promise<StartCloudflareWorkersAiAsrAfterSelectResult> => {
  const runStart = async (): Promise<StartCloudflareWorkersAiAsrAfterSelectResult> => {
    const controller = ensureWorkersAiAsrController({
      language: params.language,
      endpointUrl: params.endpointUrl,
      auth: params.auth,
      existing: params.existing,
      callbacks: params.callbacks,
      createController: params.createController,
    });
    const gate = gateWorkersAiAsrStart({
      controller,
      captureSupported: params.captureSupported,
    });
    if (!gate.ok) {
      params.onError?.(gate.message);
      return { ...gate, controller };
    }
    try {
      await gate.controller.start();
    } catch (error) {
      const message = getUserMediaErrorMessageJa(error);
      params.onError?.(message);
      return { ok: false, reason: "start-failed", message, controller: gate.controller };
    }
    if (gate.controller.currentState === "error") {
      return {
        ok: false,
        reason: "start-failed",
        message: WORKERS_AI_ASR_PREPARING_JA,
        controller: gate.controller,
      };
    }
    if (
      gate.controller.currentState !== "listening" &&
      gate.controller.currentState !== "starting"
    ) {
      const message = WORKERS_AI_ASR_PREPARING_JA;
      params.onError?.(message);
      return { ok: false, reason: "start-failed", message, controller: gate.controller };
    }
    return { ok: true, controller: gate.controller };
  };

  return new Promise((resolve) => {
    beginRecognitionListening({
      provider: "workers-ai-asr",
      start: () => {
        void runStart().then(resolve);
      },
      warmBrowserVibrato: params.warmBrowserVibrato ?? (() => Promise.resolve()),
      onWarmupNotice: params.onWarmupNotice,
      onWarmupError: params.onError,
      requireVibratoWarmup: params.requireVibratoWarmup,
    });
  });
};
