// This file runs with bun.
import { describe, expect, it } from "vitest";
import {
  COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH,
  inferenceProxyRequest,
  shouldProxyToInference,
} from "./inference-proxy";

describe("fixed inference proxy", () => {
  it("proxies the combined speech pipeline and Worker-owned lexicon only", () => {
    expect(shouldProxyToInference(COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH)).toBe(true);
    expect(shouldProxyToInference("/v1/asr/workers-ai/transcriptions")).toBe(false);
    expect(shouldProxyToInference("/ws/azookey")).toBe(false);
    expect(shouldProxyToInference("/azookey/user-lexicon")).toBe(true);
    expect(shouldProxyToInference("/azookey/user-lexicon/entries/id")).toBe(true);
    expect(shouldProxyToInference("/azookey/other")).toBe(false);
  });

  it("removes browser authorization and injects only the Worker secret", () => {
    const request = new Request(
      `https://azookey-compare.example${COMPARE_WORKERS_AI_SPEECH_PIPELINE_PATH}`,
      { headers: { authorization: "Bearer browser-token" } },
    );

    expect(inferenceProxyRequest(request).headers.get("authorization")).toBe(null);
    expect(
      inferenceProxyRequest(request, { AZOOKEY_API_TOKEN: "worker-token" }).headers.get(
        "authorization",
      ),
    ).toBe("Bearer worker-token");
  });
});
