import { strict as assert } from "node:assert";
import test from "node:test";
import { inspectMacosSigning } from "./check-macos-signing.mjs";

test("macOS signing check reports a safe skip when release secrets are absent", () => {
  const result = inspectMacosSigning({
    platform: "darwin",
    env: { KOTOBA_REQUIRE_APPLE_SIGNING: "0" },
  });
  assert.equal(result.signingReady, false);
  assert.equal(result.notarizationReady, false);
  assert.match(result.signingMissing.join(" "), /APPLE_SIGNING_IDENTITY/);
  assert.doesNotMatch(result.signingMissing.join(" "), /secret|password=/i);
});

test("strict release mode accepts either Apple ID or App Store Connect API credentials", () => {
  const common = {
    KOTOBA_REQUIRE_APPLE_SIGNING: "1",
    APPLE_CERTIFICATE: "base64-certificate",
    APPLE_CERTIFICATE_PASSWORD: "certificate-password",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM123)",
  };
  const appleId = inspectMacosSigning({
    platform: "darwin",
    env: {
      ...common,
      APPLE_ID: "release@example.test",
      APPLE_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAM123",
    },
  });
  assert.equal(appleId.signingReady, true);
  assert.equal(appleId.notarizationReady, true);

  const apiKey = inspectMacosSigning({
    platform: "darwin",
    env: {
      ...common,
      APPLE_API_KEY: "key-id",
      APPLE_API_ISSUER: "issuer-id",
      APPLE_API_KEY_PATH: "/tmp/AuthKey_KEY123.p8",
    },
  });
  assert.equal(apiKey.signingReady, true);
  assert.equal(apiKey.notarizationReady, true);
});

test("non-macOS CI is explicitly skipped unless strict release mode is requested", () => {
  const relaxed = inspectMacosSigning({ platform: "linux", env: {} });
  assert.equal(relaxed.strict, false);
  const strict = inspectMacosSigning({
    platform: "linux",
    env: { KOTOBA_REQUIRE_APPLE_SIGNING: "1" },
  });
  assert.equal(strict.strict, true);
});
