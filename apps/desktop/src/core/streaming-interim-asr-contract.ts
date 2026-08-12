/**
 * Headless contract for ReazonSpeech + Nemotron streaming interim dual-ASR.
 *
 * These helpers exist so CI / agents can verify the desktop → Parapper CLI
 * wiring without launching the Tauri UI or speaking into a microphone.
 */

import { createDefaultConfig } from "./defaults";
import {
  resolveStreamingInterimAsrCliValue,
  STREAMING_INTERIM_ASR_MODEL_ID,
  STREAMING_INTERIM_ASR_MODEL_OFF,
  type StreamingInterimAsrCliValue,
} from "./streaming-interim-asr";

export type StreamingInterimAsrHeadlessContract = {
  enabled: boolean;
  cliFlag: "--interim-asr-model";
  cliValue: StreamingInterimAsrCliValue;
  primaryCompletionAsr: "reazonspeech_k2_v2";
};

/** Build the dual-ASR CLI contract the desktop sidecar must honor. */
export const buildStreamingInterimAsrHeadlessContract = (
  enabled: boolean = createDefaultConfig().audio.streamingInterimAsrEnabled,
): StreamingInterimAsrHeadlessContract => ({
  enabled,
  cliFlag: "--interim-asr-model",
  cliValue: resolveStreamingInterimAsrCliValue(enabled),
  primaryCompletionAsr: "reazonspeech_k2_v2",
});

/**
 * Assert the contract a parent app must pass to Parapper headless.
 * Returns a list of human-readable failures (empty when healthy).
 */
export const verifyStreamingInterimAsrHeadlessContract = (
  contract: StreamingInterimAsrHeadlessContract = buildStreamingInterimAsrHeadlessContract(),
): string[] => {
  const failures: string[] = [];
  if (contract.cliFlag !== "--interim-asr-model") {
    failures.push(`unexpected CLI flag: ${contract.cliFlag}`);
  }
  if (contract.primaryCompletionAsr !== "reazonspeech_k2_v2") {
    failures.push(`primary ASR must stay ReazonSpeech K2 v2, got ${contract.primaryCompletionAsr}`);
  }
  if (contract.enabled) {
    if (contract.cliValue !== STREAMING_INTERIM_ASR_MODEL_ID) {
      failures.push(
        `enabled contract must request ${STREAMING_INTERIM_ASR_MODEL_ID}, got ${contract.cliValue}`,
      );
    }
  } else if (contract.cliValue !== STREAMING_INTERIM_ASR_MODEL_OFF) {
    failures.push(
      `disabled contract must clear interim ASR with ${STREAMING_INTERIM_ASR_MODEL_OFF}, got ${contract.cliValue}`,
    );
  }
  return failures;
};
