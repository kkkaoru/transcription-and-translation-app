import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  accessServiceTokenHeaders,
  COMPARE_HEALTH_PATH,
  COMPARE_ORIGIN,
  evaluateHostedChecks,
  INFERENCE_ORIGIN,
  isUnauthenticatedAccessStatus,
  resolveAccessServiceToken,
} from "./verify-cloudflare-hosted.mjs";

describe("verify-cloudflare-hosted", () => {
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

  it("requires unauth 401/302, ST health 200, and inference 404", () => {
    assert.deepEqual(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        authenticatedHealth: 200,
        inferenceDirect: 404,
        websocket: 101,
      }),
      { ok: true, failures: [], websocket: 101 },
    );
    const failed = evaluateHostedChecks({
      unauthenticatedHome: 200,
      unauthenticatedHealth: 401,
      authenticatedHealth: 401,
      inferenceDirect: 200,
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.websocket, "skipped");
    assert.equal(failed.failures.length, 3);
    assert.equal(
      evaluateHostedChecks({
        unauthenticatedHome: 302,
        unauthenticatedHealth: 401,
        inferenceDirect: 404,
        requireAuthenticatedHealth: false,
      }).ok,
      true,
    );
  });
});
