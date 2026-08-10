import type { ComparisonAuth } from "./contract";
import {
  WorkersAiAsrController,
  type WorkersAiAsrControllerOptions,
} from "./workers-ai-asr-controller";
import {
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
  const captureSupported = options.captureSupported ?? isWorkersAiAsrCaptureSupported();
  if (!captureSupported) {
    return { ok: false, reason: "unsupported", message: WORKERS_AI_ASR_UNSUPPORTED_JA };
  }
  if (!options.controller) {
    return { ok: false, reason: "preparing", message: WORKERS_AI_ASR_PREPARING_JA };
  }
  if (!options.controller.supported) {
    return { ok: false, reason: "unsupported", message: WORKERS_AI_ASR_UNSUPPORTED_JA };
  }
  return { ok: true, controller: options.controller };
};
