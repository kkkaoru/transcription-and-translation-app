import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertCaptionQualityGateWired,
  CAPTION_QUALITY_SUITES,
  GREETING_HARNESS_VITEST_PATH,
  runCaptionQualityGate,
} from "./verify-caption-quality.mjs";

describe("caption quality gate wiring", () => {
  it("keeps the greeting live-caption harness in the desktop quality suite", () => {
    const wired = assertCaptionQualityGateWired();
    assert.equal(wired.script, "node scripts/verify-caption-quality.mjs");
    assert.ok(wired.desktopFiles.includes(GREETING_HARNESS_VITEST_PATH));
    assert.ok(wired.desktopFiles.includes("src/overlay/caption-quality.contract.smoke.test.tsx"));
    assert.ok(wired.desktopFiles.includes("src/core/caption-updates.test.ts"));
    assert.equal(
      CAPTION_QUALITY_SUITES.some((suite) => suite.label === "sentence-boundary"),
      true,
    );
  });

  it("can inventory the gate without spawning vitest", () => {
    const skipped = runCaptionQualityGate({ spawnSuites: false });
    assert.equal(skipped.suites, "skipped");
    assert.ok(skipped.wired.desktopFiles.includes(GREETING_HARNESS_VITEST_PATH));
  });
});
