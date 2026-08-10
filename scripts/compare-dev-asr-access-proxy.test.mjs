import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  COMPARE_ASR_DEV_PROXY_ORIGIN_DEFAULT,
  COMPARE_ASR_DEV_PROXY_PORT,
  handleCompareDevAsrAccessProxyRequest,
  LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA,
} from "./compare-dev-asr-access-proxy.mjs";
import { COMPARE_ASR_PATH, COMPARE_ORIGIN } from "./verify-cloudflare-hosted.mjs";

describe("compare-dev ASR Access proxy", () => {
  it("pins the loopback proxy origin without inventing Access credentials", () => {
    assert.equal(COMPARE_ASR_DEV_PROXY_PORT, 8790);
    assert.equal(COMPARE_ASR_DEV_PROXY_ORIGIN_DEFAULT, "http://127.0.0.1:8790");
    assert.match(LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA, /Access/);
    assert.match(LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA, /worker:dev/);
  });

  it("returns JSON 503 before upstream when Access ST is missing", async () => {
    const response = await handleCompareDevAsrAccessProxyRequest(
      new Request(`http://127.0.0.1:8790${COMPARE_ASR_PATH}`, { method: "GET" }),
      { env: {}, dotenv: {} },
    );
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error.code, "asr_workers_ai_unavailable");
    assert.equal(payload.error.message, LOCAL_WORKERS_AI_ASR_UNAVAILABLE_JA);
  });

  it("probes hosted compare health with Access ST and forwards ASR POST", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers });
      if (String(url).endsWith("/v1/azookey")) {
        return Response.json({ ok: true });
      }
      return Response.json({ text: "こんにちは", model: "@cf/deepgram/nova-3", transport: "http" });
    };
    const env = {
      CF_ACCESS_CLIENT_ID: "id.access",
      CF_ACCESS_CLIENT_SECRET: "secret",
    };
    const ready = await handleCompareDevAsrAccessProxyRequest(
      new Request(`http://127.0.0.1:8790${COMPARE_ASR_PATH}`, { method: "GET" }),
      { env, dotenv: {}, fetchImpl, compareOrigin: COMPARE_ORIGIN },
    );
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, proxy: "access-compare" });

    const posted = await handleCompareDevAsrAccessProxyRequest(
      new Request(`http://127.0.0.1:8790${COMPARE_ASR_PATH}`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=test" },
        body: "wav-bytes",
      }),
      { env, dotenv: {}, fetchImpl, compareOrigin: COMPARE_ORIGIN },
    );
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), {
      text: "こんにちは",
      model: "@cf/deepgram/nova-3",
      transport: "http",
    });
    assert.equal(calls[0]?.url, `${COMPARE_ORIGIN}/v1/azookey`);
    assert.equal(calls[1]?.url, `${COMPARE_ORIGIN}${COMPARE_ASR_PATH}`);
    assert.equal(calls[1]?.method, "POST");
    assert.equal(calls[0]?.headers["CF-Access-Client-Id"], "id.access");
    assert.equal(calls[1]?.headers["CF-Access-Client-Secret"], "secret");
  });

  it("strips upstream content-encoding so next.dev can parse Nova-3 JSON", async () => {
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith("/v1/azookey")) {
        return Response.json({ ok: true });
      }
      return new Response(JSON.stringify({ text: "こんにちは", transport: "http" }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-encoding": "zstd",
          "content-length": "999",
        },
      });
    };
    const posted = await handleCompareDevAsrAccessProxyRequest(
      new Request(`http://127.0.0.1:8790${COMPARE_ASR_PATH}`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=test" },
        body: "wav-bytes",
      }),
      {
        env: { CF_ACCESS_CLIENT_ID: "id.access", CF_ACCESS_CLIENT_SECRET: "secret" },
        dotenv: {},
        fetchImpl,
        compareOrigin: COMPARE_ORIGIN,
      },
    );
    assert.equal(posted.status, 200);
    assert.equal(posted.headers.get("content-encoding"), null);
    assert.match(posted.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await posted.json(), { text: "こんにちは", transport: "http" });
  });
});

