import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  assertGreetingFixtureInventory,
  assertGreetingHarnessWired,
  assertGreetingWavFixture,
  GREETING_FIXTURES_RELATIVE_PATH,
  GREETING_HARNESS_RELATIVE_PATH,
  GREETING_PLAYBACK_CLIPS,
  GREETING_WAV_RELATIVE_PATH,
  loadGreetingLiveCaptionFixtures,
  runGreetingLiveCaptionGate,
} from "./verify-greeting-live-caption.mjs";

const clipById = (clips, id) => clips.find((row) => row.id === id);

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
    assert.equal(inventory.clips.length, GREETING_PLAYBACK_CLIPS.length);
    for (const required of GREETING_PLAYBACK_CLIPS) {
      const clip = clipById(fixtures.playback.clips, required.id);
      assert.equal(clip?.wav, required.wav);
      assert.equal(clip?.spoken, required.spoken);
      assert.equal(clip?.expectedOverlay, required.expectedOverlay);
      assert.ok(wav.clips[required.id].bytes > 1024);
    }
    assert.ok(inventory.sanitizeCount >= 8);
    assert.ok(inventory.mergeCount >= 4);
    assert.ok(inventory.pagingCount >= 15);
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "hearing-ae")?.expectedOverlay,
      "きこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-zenz-period")?.expectedOverlay,
      "こんにちは聞こえますか。",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-sayonara-period")?.expectedOverlay,
      "さようなら聞こえますか。",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-konbanwa-period")?.expectedOverlay,
      "こんばんは聞こえますか。",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-ohayou-gozaimasu-period")?.expectedOverlay,
      "おはようございます聞こえますか。",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-sayonara-period-kana")?.expectedOverlay,
      "さようならきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-konbanwa-period-kana")?.expectedOverlay,
      "こんばんはきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-ohayou-period-kana")?.expectedOverlay,
      "おはようきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "strip-ohayou-gozaimasu-period-kana")
        ?.expectedOverlay,
      "おはようございますきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "sayonara-hearing-kanji")?.expectedOverlay,
      "さようなら聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "konbanwa-hearing-kanji")?.expectedOverlay,
      "こんばんは聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-hearing-kanji")?.expectedOverlay,
      "おはよう聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "sayonara-hearing-prolonged")?.expectedOverlay,
      "さようならーきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "konbanwa-hearing-prolonged")?.expectedOverlay,
      "こんばんはーきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-hearing-prolonged")?.expectedOverlay,
      "おはようーきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-gozaimasu-hearing-prolonged")
        ?.expectedOverlay,
      "おはようございますーきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "concat-hearing-oe-kanji")?.expectedOverlay,
      "こんにちは聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "sayonara-hearing-oe-kanji")?.expectedOverlay,
      "さようなら聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "konbanwa-hearing-oe-kanji")?.expectedOverlay,
      "こんばんは聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-hearing-oe-kanji")?.expectedOverlay,
      "おはよう聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-gozaimasu-hearing-oe-kanji")
        ?.expectedOverlay,
      "おはようございます聞こえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-gozaimasu-hearing-ae")?.expectedOverlay,
      "おはようございますきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "sayonara-hearing-ae")?.expectedOverlay,
      "さようならきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "concat-hearing-oe")?.expectedOverlay,
      "こんにちはきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-hearing-oe")?.expectedOverlay,
      "おはようきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "konbanwa-hearing-oe")?.expectedOverlay,
      "こんばんはきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "ohayou-gozaimasu-hearing-oe")?.expectedOverlay,
      "おはようございますきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "concat-hearing-prolonged-ae")?.expectedOverlay,
      "こんにちはーきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "sayonara-hearing-prolonged-ae")?.expectedOverlay,
      "さようならーきこえますか",
    );
    assert.equal(
      fixtures.sanitize.find((row) => row.id === "konbanwa-hearing-prolonged-ae")?.expectedOverlay,
      "こんばんはーきこえますか",
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
      fixtures.merge.find((row) => row.id === "second-utterance-after-sayonara")
        ?.expectedOverlayContains,
      "きこえますか",
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
      fixtures.merge.find((row) => row.id === "second-utterance-after-konbanwa")
        ?.expectedOverlayContains,
      "きこえますか",
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
      fixtures.merge.find((row) => row.id === "second-utterance-after-ohayou-gozaimasu")
        ?.expectedOverlayContains,
      "きこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-ohayou-over-ack")?.expectedOverlay,
      "おはよう",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-ohayou-over-un")?.expectedOverlay,
      "おはよう",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-longer-ohayou-hearing-final")?.expectedOverlay,
      "おはようきこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "second-utterance-after-ohayou")
        ?.expectedOverlayContains,
      "きこえますか",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-konbanwa-over-ee")?.expectedOverlay,
      "こんばんは",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-sayonara-over-iie")?.expectedOverlay,
      "さようなら",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-ohayou-gozaimasu-over-un")?.expectedOverlay,
      "おはようございます",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-ohayou-gozaimasu-over-ee")?.expectedOverlay,
      "おはようございます",
    );
    assert.equal(
      fixtures.merge.find((row) => row.id === "keep-ohayou-gozaimasu-over-iie")?.expectedOverlay,
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
    assert.equal(
      fixtures.paging.find((row) => row.id === "stale-vibrato-offset-ohayou-gozaimasu")
        ?.expectedVisible,
      "おはようございますきこえますか",
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
    for (const required of GREETING_PLAYBACK_CLIPS) {
      assert.ok(skipped.wav.clips[required.id].bytes > 1024);
    }
  });
});
