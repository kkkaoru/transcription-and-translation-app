// This file runs with bun.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPARE_WORKER_ORIGIN, COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH } from "./inference-proxy";

const jsonc = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");

describe("azookey-compare Worker deployment configuration", () => {
  it("keeps one service-bound inference route and no public account selection", () => {
    expect(jsonc).not.toMatch(/^\s*"account_id"\s*:/m);
    expect(jsonc).toMatch(/"name": "azookey-compare"/);
    expect(jsonc).toMatch(/"binding": "INFERENCE"/);
    expect(jsonc).toMatch(/"service": "kotoba-beacon-inference"/);
    expect(jsonc).not.toMatch(/AZOOKEY_API_TOKEN.*required/);
    expect(COMPARE_WORKER_ORIGIN).toBe("https://azookey-compare.kaoru.workers.dev");
    expect(COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH).toBe("/v1/speech/workers-ai/azookey");
  });
});
