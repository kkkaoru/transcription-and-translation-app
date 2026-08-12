import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertGreetingFixtureInventory,
  assertGreetingHarnessWired,
  assertGreetingWavFixture,
  GREETING_FIXTURES_RELATIVE_PATH,
  GREETING_HARNESS_RELATIVE_PATH,
  GREETING_WAV_RELATIVE_PATH,
  loadGreetingLiveCaptionFixtures,
  runGreetingLiveCaptionGate,
} from "./verify-greeting-live-caption.mjs";

describe("greeting live-caption regression harness", () => {
  it("keeps a check-in-able fixture table for こんにちは / きこえますか", () => {
    const inventory = assertGreetingFixtureInventory();
    const fixtures = loadGreetingLiveCaptionFixtures();
    assert.equal(inventory.playbackEnv, "KOTOBA_BEACON_GREETING_WAV");
    assert.equal(inventory.playbackWav, GREETING_WAV_RELATIVE_PATH);
    assert.match(inventory.playbackCommand, /greeting-kikoemasu\.wav/);
    const wav = assertGreetingWavFixture();
    assert.equal(wav.wavPath.endsWith("greeting-kikoemasu.wav"), true);
    assert.ok(wav.bytes > 1024);
    assert.equal(fixtures.playback.expectedOverlay, "こんにちはきこえますか");
    assert.equal(fixtures.playback.spoken, "こんにちは、きこえますか");
    assert.ok(inventory.sanitizeCount >= 8);
    assert.ok(inventory.mergeCount >= 4);
    assert.ok(inventory.pagingCount >= 3);
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "hearing-ae")?.expectedOverlay,
      "きこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-zenz-period")?.expectedOverlay,
      "こんにちは聞こえますか。",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "append-kikoemasu")?.expectedOverlay,
      "こんにちはきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "morning-hearing")?.expectedOverlay,
      "おはようきこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "append-kikoemasu-after-ohayou")?.expectedOverlay,
      "おはようきこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-greeting-over-un")?.expectedOverlay,
      "こんにちは",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-greeting-over-ee")?.expectedOverlay,
      "こんにちは",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "append-kikoemasu-after-sayonara")?.expectedOverlay,
      "さようならきこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-sayonara-over-ack")?.expectedOverlay,
      "さようなら",
    );
    assert.equal(GREETING_FIXTURES_RELATIVE_PATH.endsWith(".json"), true);
  });

  it("wires the desktop harness and caption-quality gate without live audio", () => {
    const wired = assertGreetingHarnessWired();
    assert.equal(wired.script, "node scripts/verify-greeting-live-caption.mjs");
    assert.match(wired.harnessPath, new RegExp(`${GREETING_HARNESS_RELATIVE_PATH}$`));
    const skipped = runGreetingLiveCaptionGate({ spawnVitest: false });
    assert.equal(skipped.vitest, "skipped");
    assert.equal(skipped.inventory.playbackEnv, "KOTOBA_BEACON_GREETING_WAV");
    assert.ok(skipped.wav.bytes > 1024);
  });
});
