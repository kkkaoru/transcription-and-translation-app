#!/usr/bin/env node

/**
 * Report whether a macOS release runner can sign and notarize a Tauri bundle.
 *
 * This is deliberately a prerequisite check, not a fake signing step.  GitHub
 * pull requests (especially PRs from forks) do not receive Apple secrets, so
 * the normal CI build is allowed to produce an unsigned local-validation app.
 * A release workflow can set KOTOBA_REQUIRE_APPLE_SIGNING=1 to turn the same
 * missing credentials into a hard failure before spending time on a bundle.
 */

import { spawnSync } from "node:child_process";

const present = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [options]
 */
export const inspectMacosSigning = ({ platform = process.platform, env = process.env } = {}) => {
  const strict = env.KOTOBA_REQUIRE_APPLE_SIGNING === "1";
  const signingCertificate = present(env.APPLE_CERTIFICATE);
  const certificateAlreadyInstalled = env.KOTOBA_APPLE_CERTIFICATE_INSTALLED === "1";
  const signingIdentity = present(env.APPLE_SIGNING_IDENTITY);
  const signingMissing = [
    ...(signingIdentity ? [] : ["APPLE_SIGNING_IDENTITY"]),
    ...(signingCertificate || certificateAlreadyInstalled
      ? []
      : ["APPLE_CERTIFICATE (or KOTOBA_APPLE_CERTIFICATE_INSTALLED=1)"]),
    ...(signingCertificate && !present(env.APPLE_CERTIFICATE_PASSWORD)
      ? ["APPLE_CERTIFICATE_PASSWORD"]
      : []),
  ];

  const appleIdNotarization =
    present(env.APPLE_ID) && present(env.APPLE_PASSWORD) && present(env.APPLE_TEAM_ID);
  const apiKeyNotarization =
    present(env.APPLE_API_KEY) && present(env.APPLE_API_ISSUER) && present(env.APPLE_API_KEY_PATH);
  const notarizationMissing =
    appleIdNotarization || apiKeyNotarization
      ? []
      : [
          "APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID (or APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH)",
        ];

  return {
    platform,
    strict,
    signingReady: signingMissing.length === 0,
    notarizationReady: notarizationMissing.length === 0,
    signingMissing,
    notarizationMissing,
  };
};

const commandAvailable = (command, args) => {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
};

const run = () => {
  const state = inspectMacosSigning();
  if (state.platform !== "darwin") {
    if (state.strict) {
      console.error(
        "APPLE signing/notarization was required, but this job is not running on macOS.",
      );
      return 2;
    }
    console.log(
      `SKIP: Apple signing/notarization prerequisites apply only on macOS (host=${state.platform}).`,
    );
    return 0;
  }

  const missing = [...state.signingMissing, ...state.notarizationMissing];
  if (missing.length > 0) {
    const detail = missing.join(", ");
    if (state.strict) {
      console.error(`FAIL: macOS release credentials are incomplete: ${detail}`);
      return 2;
    }
    console.log(
      `SKIP: unsigned/not-notarized macOS validation build; missing release credentials: ${detail}`,
    );
    console.log(
      "Set KOTOBA_REQUIRE_APPLE_SIGNING=1 in a trusted release job to enforce these prerequisites.",
    );
    return 0;
  }

  const missingTools = [
    ["codesign", ["--version"], "codesign"],
    ["xcrun codesign", ["--find", "codesign"], "xcrun"],
    ["xcrun notarytool", ["--find", "notarytool"], "xcrun"],
  ]
    .filter(([, args, executable]) => !commandAvailable(executable, args))
    .map(([command]) => command);
  if (missingTools.length > 0) {
    const detail = missingTools.join(", ");
    if (state.strict) {
      console.error(`FAIL: macOS signing/notarization tools are unavailable: ${detail}`);
      return 2;
    }
    console.log(`SKIP: release credentials are present but tools are unavailable: ${detail}`);
    return 0;
  }

  console.log("PASS: macOS signing and notarization prerequisites are present.");
  console.log(
    "The caller still needs to run Tauri's codesign/notarytool release steps; this check never handles secrets itself.",
  );
  return 0;
};

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  process.exitCode = run();
}
