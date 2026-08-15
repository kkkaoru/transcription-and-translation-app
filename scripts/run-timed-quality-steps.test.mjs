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

  it("uses whole-run totals and separate step overhead on success", () => {
    let clock = 1_000;
    const result = runTimedQualitySteps({
      steps: ["lint", "format:check"],
      now: () => {
        clock += 100;
        return clock;
      },
      runSync: () => ({ status: 0, signal: null }),
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.totalMs, 600);
    assert.equal(result.stepsTotalMs, 200);
    assert.equal(result.overheadMs, 400);
  });

  it("records stable identities and uses the same whole-run total on child failure", () => {
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
    assert.equal(result.totalMs, 1_500);
    assert.equal(result.stepsTotalMs, 500);
    assert.equal(result.overheadMs, 1_000);
  });

  for (const scenario of [
    {
      name: "spawn error",
      child: { status: null, signal: null, error: new Error("spawn failed") },
    },
    {
      name: "signal",
      child: { status: null, signal: "SIGTERM" },
    },
  ]) {
    it(`uses the whole-run total after a ${scenario.name}`, () => {
      let clock = 0;
      const result = runTimedQualitySteps({
        steps: ["lint"],
        now: () => {
          clock += 10;
          return clock;
        },
        runSync: () => scenario.child,
        stdout: () => {},
        stderr: () => {},
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.totalMs, 30);
      assert.equal(result.stepsTotalMs, 10);
      assert.equal(result.overheadMs, 20);
    });
  }
});
