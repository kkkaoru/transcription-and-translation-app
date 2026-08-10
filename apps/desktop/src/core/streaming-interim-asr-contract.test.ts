import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "./defaults";
import {
  buildStreamingInterimAsrHeadlessContract,
  verifyStreamingInterimAsrHeadlessContract,
} from "./streaming-interim-asr-contract";
import { STREAMING_INTERIM_ASR_MODEL_ID, STREAMING_INTERIM_ASR_MODEL_OFF } from "./streaming-interim-asr";

describe("streaming interim ASR headless contract", () => {
  it("defaults to Nemotron 160ms int8 beside ReazonSpeech without human setup", () => {
    const config = createDefaultConfig();
    expect(config.audio.streamingInterimAsrEnabled).toBe(true);

    const contract = buildStreamingInterimAsrHeadlessContract();
    expect(contract).toEqual({
      enabled: true,
      cliFlag: "--interim-asr-model",
      cliValue: STREAMING_INTERIM_ASR_MODEL_ID,
      primaryCompletionAsr: "reazonspeech_k2_v2",
    });
    expect(verifyStreamingInterimAsrHeadlessContract(contract)).toEqual([]);
  });

  it("clears the interim model when the setting is off", () => {
    const contract = buildStreamingInterimAsrHeadlessContract(false);
    expect(contract.cliValue).toBe(STREAMING_INTERIM_ASR_MODEL_OFF);
    expect(verifyStreamingInterimAsrHeadlessContract(contract)).toEqual([]);
  });

  it("reports contract drift instead of silently accepting a bad payload", () => {
    expect(
      verifyStreamingInterimAsrHeadlessContract({
        enabled: true,
        cliFlag: "--interim-asr-model",
        cliValue: STREAMING_INTERIM_ASR_MODEL_OFF,
        primaryCompletionAsr: "reazonspeech_k2_v2",
      }),
    ).toEqual([
      `enabled contract must request ${STREAMING_INTERIM_ASR_MODEL_ID}, got ${STREAMING_INTERIM_ASR_MODEL_OFF}`,
    ]);

    expect(
      verifyStreamingInterimAsrHeadlessContract({
        enabled: false,
        cliFlag: "--mystery" as "--interim-asr-model",
        cliValue: STREAMING_INTERIM_ASR_MODEL_ID,
        primaryCompletionAsr: "nemo_parakeet_tdt_0_6b_v2_int8" as "reazonspeech_k2_v2",
      }),
    ).toEqual([
      "unexpected CLI flag: --mystery",
      "primary ASR must stay ReazonSpeech K2 v2, got nemo_parakeet_tdt_0_6b_v2_int8",
      `disabled contract must clear interim ASR with ${STREAMING_INTERIM_ASR_MODEL_OFF}, got ${STREAMING_INTERIM_ASR_MODEL_ID}`,
    ]);
  });
});
