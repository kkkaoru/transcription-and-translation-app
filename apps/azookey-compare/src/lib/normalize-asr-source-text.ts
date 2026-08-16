/**
 * This file runs with bun.
 *
 * Comparison-app re-export of the shared Japanese ASR source normalizer.
 * Worker `/v1/asr/workers-ai/transcriptions` and `/ws/azookey` use the same
 * function from `@caption-bridge/azookey-reading`.
 */

export { normalizeAsrSourceText } from "@caption-bridge/azookey-reading";
