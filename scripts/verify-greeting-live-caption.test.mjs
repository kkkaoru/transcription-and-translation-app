import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertGreetingFixtureInventory,
  assertGreetingHarnessWired,
  assertGreetingWavFixture,
  GREETING_FIXTURES_RELATIVE_PATH,
  GREETING_HARNESS_RELATIVE_PATH,
  GREETING_KONBANWA_WAV_RELATIVE_PATH,
  GREETING_OHAYOU_WAV_RELATIVE_PATH,
  GREETING_SAYONARA_WAV_RELATIVE_PATH,
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
    assert.ok(inventory.pagingCount >= 12);
    assert.equal(inventory.sayonaraWav, GREETING_SAYONARA_WAV_RELATIVE_PATH);
    assert.ok(wav.sayonara.bytes > 1024);
    assert.equal(fixtures.playback.sayonaraExpectedOverlay, "さようならきこえますか");
    assert.equal(inventory.ohayouWav, GREETING_OHAYOU_WAV_RELATIVE_PATH);
    assert.ok(wav.ohayou.bytes > 1024);
    assert.equal(fixtures.playback.ohayouExpectedOverlay, "おはようきこえますか");
    assert.equal(inventory.konbanwaWav, GREETING_KONBANWA_WAV_RELATIVE_PATH);
    assert.ok(wav.konbanwa.bytes > 1024);
    assert.equal(fixtures.playback.konbanwaExpectedOverlay, "こんばんはきこえますか");
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
      fixtures.merge.find((row) => row.id === "keep-greeting-over-iie")?.expectedOverlay,
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
    assert.equal(
      fixtures.merge.find((row) => row.id === "append-kikoemasu-after-konbanwa")?.expectedOverlay,
      "こんばんはきこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-konbanwa-over-ack")?.expectedOverlay,
      "こんばんは",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "append-kikoemasu-after-ohayou-gozaimasu")
        ?.expectedOverlay,
      "おはようございますきこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-ohayou-gozaimasu-over-ack")?.expectedOverlay,
      "おはようございます",
    );
    assert.equal(
      fixtures.paging.find((row) => row.id === "stale-vibrato-offset-sayonara")?.expectedVisible,
      "さようならきこえますか",
    );
    assert.equal(
      fixtures.paging.find((row) => row.id === "stale-vibrato-offset-konbanwa")?.expectedVisible,
      "こんばんはきこえますか",
    );
    assert.equal(
      fixtures.paging.find((row) => row.id === "stale-vibrato-offset-ohayou")?.expectedVisible,
      "おはようきこえますか",
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
    assert.ok(skipped.wav.sayonara.bytes > 1024);
    assert.ok(skipped.wav.ohayou.bytes > 1024);
    assert.ok(skipped.wav.konbanwa.bytes > 1024);
  });
});
