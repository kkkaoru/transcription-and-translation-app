import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  accessServiceTokenHeaders,
  COMPARE_HEALTH_PATH,
  COMPARE_ORIGIN,
  evaluateHostedChecks,
  GREETING_SPEECH_WAV_RELATIVE_PATH,
  INFERENCE_ORIGIN,
  isAcceptableElapsedMs,
  isRecordedElapsedMs,
  isUnauthenticatedAccessStatus,
  loadGreetingSpeechWav,
  recordedElapsedMs,
  resolveAccessServiceToken,
  summarizeWebsocketConversion,
} from "./verify-cloudflare-hosted.mjs";

describe("verify-cloudflare-hosted", () => {
  it("loads the desktop greeting speech fixture for hosted ASR probes", () => {
    assert.equal(
      GREETING_SPEECH_WAV_RELATIVE_PATH,
      "apps/desktop/src/overlay/fixtures/greeting-kikoemasu.wav",
    );
    const wav = loadGreetingSpeechWav();
    assert.equal(wav.byteLength > 10_000, true);
    assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
  });

  it("treats Access 401 and 302 as unauthenticated success", () => {
    assert.equal(isUnauthenticatedAccessStatus(401), true);
    assert.equal(isUnauthenticatedAccessStatus(302), true);
    assert.equal(isUnauthenticatedAccessStatus(200), false);
    assert.equal(isUnauthenticatedAccessStatus(403), false);
  });

  it("builds Service Token headers without inventing credentials", () => {
    assert.equal(COMPARE_ORIGIN, "https://azookey-compare.kaoru.workers.dev");
    assert.equal(INFERENCE_ORIGIN, "https://kotoba-beacon-inference.kaoru.workers.dev");
    assert.equal(COMPARE_HEALTH_PATH, "/v1/azookey");
    assert.deepEqual(accessServiceTokenHeaders({ clientId: "id.access", clientSecret: "secret" }), {
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "secret",
    });
    assert.equal(resolveAccessServiceToken({ env: {}, dotenv: {} }), undefined);
    assert.equal(
      resolveAccessServiceToken({
        env: { CF_ACCESS_CLIENT_ID: "id-only" },
        dotenv: {},
      }),
      undefined,
    );
    assert.deepEqual(
      resolveAccessServiceToken({
        env: {},
        dotenv: {
          CF_ACCESS_CLIENT_ID: "id.access",
          CF_ACCESS_CLIENT_SECRET: "secret",
        },
      }),
      { clientId: "id.access", clientSecret: "secret" },
    );
  });

  it("requires unauth 401/302, ST health 200, inference 404, and WS conversion", () => {
    assert.deepEqual(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        authenticatedHealth: 200,
        inferenceDirect: 404,
        websocket: 101,
        websocketConversion: {
          ok: true,
          input: "きょうはいいてんき",
          convertedText: "今日はいい天気",
          elapsedMs: 12,
        },
      }),
      {
        ok: true,
        failures: [],
        websocket: 101,
        websocketConversion: {
          ok: true,
          input: "きょうはいいてんき",
          convertedText: "今日はいい天気",
          elapsedMs: 12,
        },
      },
    );
    const failed = evaluateHostedChecks({
      unauthenticatedHome: 200,
      unauthenticatedHealth: 401,
      authenticatedHealth: 401,
      inferenceDirect: 200,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.websocket, "skipped");
    assert.equal(failed.websocketConversion, "skipped");
    assert.equal(failed.failures.length, 4);
    assert.equal(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        inferenceDirect: 404,
        requireAuthenticatedHealth: false,
        requireWebsocketConversion: false,
      }).ok,
      true,
    );
    assert.match(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        authenticatedHealth: 200,
        inferenceDirect: 404,
        websocketConversion: { ok: false, stage: "azookey_error", code: "unauthorized" },
      }).failures[0],
      /WS conversion failed/,
    );
    assert.match(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        authenticatedHealth: 200,
        inferenceDirect: 404,
        websocketConversion: { ok: true, convertedText: "今日はいい天気" },
      }).failures[0],
      /missing elapsedMs\/elapsed_ms/,
    );
    assert.equal(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        authenticatedHealth: 200,
        inferenceDirect: 404,
        websocketConversion: {
          ok: true,
          convertedText: "今日はいい天気",
          elapsed_ms: 18,
        },
      }).ok,
      true,
    );
    assert.equal(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        authenticatedHealth: 200,
        inferenceDirect: 404,
        websocketConversion: {
          ok: true,
          convertedText: "今日はいい天気",
          elapsedMs: 1,
        },
      }).ok,
      true,
    );
    assert.match(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        authenticatedHealth: 200,
        inferenceDirect: 404,
        websocketConversion: {
          ok: true,
          convertedText: "今日はいい天気",
          elapsedMs: 0,
        },
      }).failures[0],
      /elapsedMs\/elapsed_ms must be >= 1/,
    );
  });

  it("records A's elapsedMs/elapsed_ms without inventing a timer", () => {
    assert.equal(isRecordedElapsedMs(0), true);
    assert.equal(isAcceptableElapsedMs(0), false);
    assert.equal(isAcceptableElapsedMs(1), true);
    assert.equal(isRecordedElapsedMs(12), true);
    assert.equal(isRecordedElapsedMs(undefined), false);
    assert.equal(isRecordedElapsedMs(Number.NaN), false);
    assert.equal(recordedElapsedMs({ elapsedMs: 12, elapsed_ms: 99 }), 12);
    assert.equal(recordedElapsedMs({ elapsed_ms: 18 }), 18);
    assert.equal(recordedElapsedMs({ convertedText: "今日はいい天気" }), undefined);
    assert.deepEqual(
      summarizeWebsocketConversion({
        ok: true,
        input: "きょうはいいてんき",
        convertedText: "今日はいい天気",
        elapsed_ms: 18,
      }),
      {
        ok: true,
        input: "きょうはいいてんき",
        convertedText: "今日はいい天気",
        elapsedMs: 18,
        model: undefined,
      },
    );
  });
});
