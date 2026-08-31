import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzePipelineRecords,
  defaultLogPath,
  main,
  parsePipelineJsonl,
} from "./analyze-native-pipeline.mjs";

const record = (sequence, timestamp, stage, payload) => ({
  process_id: 42,
  session_started_unix_ms: 1_000,
  sequence,
  timestamp_unix_ms: timestamp,
  stage,
  payload,
});

describe("Native pipeline diagnostics analyzer", () => {
  it("passes a caption that is routed and applied in one short turn", () => {
    const report = analyzePipelineRecords([
      record(1, 850, "asr_partial_window", {
        turn_session_id: 1,
        logical_turn_id: 7,
        displayed: true,
      }),
      record(2, 900, "partial_window_routed", { revision: 6 }),
      record(3, 910, "ui_caption_applied", { revision: 6 }),
      record(4, 1_000, "asr_engine_caption", {
        turn_id: "turn-1-7-0",
        surface: "こんばんは...",
        is_final: false,
        speech_to_first_partial_millis: 1_800,
      }),
      record(5, 1_001, "asr_routed", { revision: 7 }),
      record(6, 1_010, "ui_caption_applied", { revision: 7 }),
      record(7, 1_700, "asr_engine_caption", {
        turn_id: "turn-1-7-0",
        surface: "こんばんは。",
        is_final: true,
      }),
    ]);

    assert.equal(report.result, "PASS");
    assert.deepEqual(report.issues, []);
  });

  it("classifies long-pause merging, prefix loss, UI loss, and slow first display", () => {
    const report = analyzePipelineRecords([
      record(1, 1_000, "asr_engine_caption", {
        turn_id: "turn-1",
        surface: "先の発話...",
        is_final: false,
        speech_to_first_partial_millis: 1_800,
      }),
      record(2, 1_010, "asr_routed", { revision: 8 }),
      record(3, 1_600, "asr_engine_caption", {
        turn_id: "turn-1",
        surface: "先の発話です...",
        is_final: false,
      }),
      record(4, 4_200, "asr_engine_caption", {
        turn_id: "turn-1",
        surface: "先の発話です後の発話...",
        is_final: false,
      }),
      record(5, 4_500, "asr_engine_caption", {
        turn_id: "turn-1",
        surface: "後の発話。",
        is_final: true,
      }),
      record(6, 4_600, "ui_caption_discarded", { reason: "stale_revision" }),
    ]);

    assert.equal(report.result, "FAIL");
    assert.deepEqual(report.issue_counts, {
      slow_first_caption: 1,
      long_gap_same_turn_merge: 1,
      final_dropped_visible_prefix: 1,
      routed_caption_not_applied: 1,
      ui_discarded_caption: 1,
    });
  });

  it("keeps sessions independent when revision numbers restart", () => {
    const secondSession = {
      ...record(2, 2_000, "ui_caption_applied", { revision: 1 }),
      session_started_unix_ms: 2_000,
    };
    const report = analyzePipelineRecords([
      record(1, 1_000, "asr_routed", { revision: 1 }),
      secondSession,
    ]);

    assert.equal(report.issue_counts.routed_caption_not_applied, 1);
  });

  it("reports malformed JSONL with its line number", () => {
    assert.throws(() => parsePipelineJsonl('{"stage":"ok"}\nnot-json\n'), /line 2/u);
  });

  it("runs explicit and default diagnostic inputs with fail-on-issues semantics", () => {
    const logs = [];
    const explicit = main(["first.jsonl", "second.jsonl"], {
      readFile: (path, encoding) => {
        assert.equal(encoding, "utf8");
        if (path === "first.jsonl") {
          return `${JSON.stringify(record(1, 1_000, "asr_routed", { revision: 1 }))}\n`;
        }
        assert.equal(path, "second.jsonl");
        return `${JSON.stringify(record(2, 1_010, "ui_caption_applied", { revision: 1 }))}\n`;
      },
      log: (message) => logs.push(message),
    });
    assert.equal(explicit.result, "PASS");
    assert.equal(JSON.parse(logs[0]).record_count, 2);

    let exitCode = 0;
    const fallback = defaultLogPath();
    const failed = main(["--fail-on-issues"], {
      readFile: (path, encoding) => {
        assert.equal(path, fallback);
        assert.equal(encoding, "utf8");
        return `${JSON.stringify(
          record(3, 2_000, "ui_caption_discarded", { reason: "stale_revision" }),
        )}\n`;
      },
      log: (message) => logs.push(message),
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    assert.equal(failed.result, "FAIL");
    assert.equal(exitCode, 1);
    assert.equal(JSON.parse(logs[1]).issue_counts.ui_discarded_caption, 1);
  });
});
