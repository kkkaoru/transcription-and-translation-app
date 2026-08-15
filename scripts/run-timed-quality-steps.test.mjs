import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUALITY_GATE_STEPS } from "./quality-gate-steps.mjs";
import { describeQualitySteps, runTimedQualitySteps } from "./run-timed-quality-steps.mjs";

describe("timed quality steps", () => {
  it("keeps the post-build assets:verify after worker:typecheck", () => {
    const first = QUALITY_GATE_STEPS.indexOf("assets:verify");
    const second = QUALITY_GATE_STEPS.indexOf("assets:verify", first + 1);
    const workerTypecheck = QUALITY_GATE_STEPS.indexOf("worker:typecheck");
    assert.ok(first >= 0 && second > first);
    assert.ok(first < workerTypecheck && workerTypecheck < second);
  });

  it("gives every planned step a stable identity and semantic asset labels", () => {
    const described = describeQualitySteps(QUALITY_GATE_STEPS);
    assert.equal(described.length, 46);
    assert.equal(new Set(described.map(({ id }) => id)).size, described.length);
    assert.deepEqual(described[3], {
      id: "assets:verify:checkout-baseline",
      script: "assets:verify",
      label: "assets:verify (checkout baseline)",
      index: 4,
      occurrence: 1,
    });
    assert.deepEqual(described[17], {
      id: "assets:verify:post-worker-build",
      script: "assets:verify",
      label: "assets:verify (post worker:typecheck)",
      index: 18,
      occurrence: 2,
    });
  });

  it("rejects an unlabelled duplicate before starting expensive work", () => {
    assert.throws(() => describeQualitySteps(["lint", "lint"]), /duplicate quality-step id: lint/u);
  });

  it("records stable identities and stops after the first failure", () => {
    let clock = 1_000;
    const invoked = [];
    const result = runTimedQualitySteps({
      steps: ["lint", "format:check", "assets:verify"],
      now: () => {
        clock += 250;
        return clock;
      },
      runSync: (_command, args) => {
        invoked.push(args[1]);
        return {
          status: args[1] === "format:check" ? 2 : 0,
          signal: null,
        };
      },
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.exitCode, 2);
    assert.deepEqual(invoked, ["lint", "format:check"]);
    assert.equal(result.records.length, 2);
    assert.deepEqual(
      result.records.map(({ id, script, label, index, occurrence }) => ({
        id,
        script,
        label,
        index,
        occurrence,
      })),
      [
        {
          id: "lint",
          script: "lint",
          label: "lint",
          index: 1,
          occurrence: 1,
        },
        {
          id: "format:check",
          script: "format:check",
          label: "format:check",
          index: 2,
          occurrence: 1,
        },
      ],
    );
    assert.ok(result.records.every((record) => record.durationMs >= 0));
  });
});
