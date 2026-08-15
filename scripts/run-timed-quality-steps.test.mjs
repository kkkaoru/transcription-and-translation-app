import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUALITY_GATE_STEPS } from "./quality-gate-steps.mjs";
import { runTimedQualitySteps } from "./run-timed-quality-steps.mjs";

describe("timed quality steps", () => {
  it("keeps the post-build assets:verify after worker:typecheck", () => {
    const first = QUALITY_GATE_STEPS.indexOf("assets:verify");
    const second = QUALITY_GATE_STEPS.indexOf("assets:verify", first + 1);
    const workerTypecheck = QUALITY_GATE_STEPS.indexOf("worker:typecheck");
    assert.ok(first >= 0 && second > first);
    assert.ok(first < workerTypecheck && workerTypecheck < second);
  });

  it("records monotonic durations and stops after the first failure", () => {
    let clock = 1_000;
    const result = runTimedQualitySteps({
      steps: ["lint", "format:check", "assets:verify"],
      now: () => {
        clock += 250;
        return clock;
      },
      runSync: (_command, args) => ({
        status: args[1] === "format:check" ? 2 : 0,
        signal: null,
      }),
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0]?.script, "lint");
    assert.equal(result.records[1]?.script, "format:check");
    assert.ok(result.records.every((record) => record.durationMs >= 0));
  });
});
