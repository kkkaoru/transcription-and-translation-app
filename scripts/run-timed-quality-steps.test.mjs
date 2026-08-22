import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { QUALITY_GATE_STEPS } from "./quality-gate-steps.mjs";
import {
  describeQualitySteps,
  runTimedQualitySteps,
  runTimedQualityStepsMain,
  serializeTimingSummary,
  TIMING_ARTIFACT_EXIT_CODE,
  writeTimingSummary,
} from "./run-timed-quality-steps.mjs";

describe("timed quality steps", () => {
  it("keeps the post-build assets:verify after worker:typecheck", () => {
    const first = QUALITY_GATE_STEPS.indexOf("assets:verify");
    const second = QUALITY_GATE_STEPS.indexOf("assets:verify", first + 1);
    const workerTypecheck = QUALITY_GATE_STEPS.indexOf("worker:typecheck");
    assert.ok(first >= 0 && second > first);
    assert.ok(first < workerTypecheck && workerTypecheck < second);
  });

  it("pins every stable quality-step id in execution order", () => {
    assert.deepEqual(
      describeQualitySteps(QUALITY_GATE_STEPS).map(({ id }) => id),
      [
        "rust:native:build",
        "lint",
        "format:check",
        "assets:verify:checkout-baseline",
        "test:build-cleanup",
        "typecheck",
        "azookey-reading:typecheck",
        "dictionaries:typecheck",
        "sentence-boundary:typecheck",
        "azookey-compare:typecheck",
        "test:coverage",
        "core:test:coverage",
        "azookey-reading:test:coverage",
        "dictionaries:test:coverage",
        "sentence-boundary:test:coverage",
        "azookey-compare:test:coverage",
        "gateway:build",
        "gateway:test:coverage",
        "worker:typecheck",
        "assets:verify:post-worker-build",
        "worker:test:coverage",
        "parapper:lint",
        "parapper:typecheck",
        "parapper:test:ui",
        "parapper:test:coverage",
        "parapper:rust:fmt",
        "parapper:rust:lint",
        "parapper:rust:test",
        "rust:azookey:fmt",
        "rust:azookey:lint",
        "rust:azookey:test",
        "rust:input-lm:fmt",
        "rust:input-lm:lint",
        "rust:input-lm:test",
        "rust:zenz-verifier:fmt",
        "rust:zenz-verifier:lint",
        "rust:zenz-verifier:test",
        "rust:vibrato:fmt",
        "rust:vibrato:lint",
        "rust:vibrato:test",
        "rust:vibrato:wasm:build",
        "rust:wasm:fmt",
        "rust:wasm:lint",
        "rust:wasm:test",
        "rust:wasm:build",
      ],
    );
  });

  it("invokes the default-feature native GPUI build", () => {
    assert.ok(QUALITY_GATE_STEPS.includes("rust:native:build"));
  });

  it("gives every planned step a stable identity and semantic asset labels", () => {
    const described = describeQualitySteps(QUALITY_GATE_STEPS);
    assert.equal(described.length, 45);
    assert.equal(new Set(described.map(({ id }) => id)).size, described.length);
    assert.deepEqual(described[3], {
      id: "assets:verify:checkout-baseline",
      script: "assets:verify",
      label: "assets:verify (checkout baseline)",
      index: 4,
      occurrence: 1,
    });
    assert.deepEqual(described[19], {
      id: "assets:verify:post-worker-build",
      script: "assets:verify",
      label: "assets:verify (post worker:typecheck)",
      index: 20,
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

  const timingResult = {
    exitCode: 0,
    plannedStepCount: 0,
    totalMs: 30,
    stepsTotalMs: 10,
    overheadMs: 20,
    records: [],
  };

  it("serializes a versioned complete quality-gate success with a fixed clock", () => {
    const records = describeQualitySteps(QUALITY_GATE_STEPS).map((step) => ({
      ...step,
      durationMs: 10,
      status: 0,
      signal: null,
    }));
    const payload = serializeTimingSummary(
      {
        exitCode: 0,
        plannedStepCount: 45,
        totalMs: 470,
        stepsTotalMs: 450,
        overheadMs: 20,
        records,
      },
      { getRecordedAt: () => "2026-08-15T18:52:00.000Z" },
    );
    const parsed = JSON.parse(payload);
    assert.equal(payload.endsWith("\n"), true);
    assert.deepEqual(
      {
        schemaVersion: parsed.schemaVersion,
        recordedAt: parsed.recordedAt,
        outcome: parsed.outcome,
        exitCode: parsed.exitCode,
        plannedStepCount: parsed.plannedStepCount,
        recordedStepCount: parsed.recordedStepCount,
        totalMs: parsed.totalMs,
        stepsTotalMs: parsed.stepsTotalMs,
        overheadMs: parsed.overheadMs,
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-08-15T18:52:00.000Z",
        outcome: "passed",
        exitCode: 0,
        plannedStepCount: 45,
        recordedStepCount: 45,
        totalMs: 470,
        stepsTotalMs: 450,
        overheadMs: 20,
      },
    );
    assert.equal(parsed.steps.length, 45);
    assert.deepEqual(Object.keys(parsed.steps[0]), [
      "id",
      "script",
      "label",
      "index",
      "occurrence",
      "durationMs",
      "status",
      "signal",
    ]);
  });

  it("serializes the same required schema for a partial failure", () => {
    const payload = serializeTimingSummary(
      {
        exitCode: 2,
        plannedStepCount: 49,
        totalMs: 25,
        stepsTotalMs: 20,
        overheadMs: 5,
        records: [
          {
            id: "lint",
            script: "lint",
            label: "lint",
            index: 1,
            occurrence: 1,
            durationMs: 20,
            status: 2,
            signal: null,
          },
        ],
      },
      { getRecordedAt: () => "2026-08-15T18:52:01.000Z" },
    );
    assert.deepEqual(JSON.parse(payload), {
      schemaVersion: 1,
      recordedAt: "2026-08-15T18:52:01.000Z",
      outcome: "failed",
      exitCode: 2,
      plannedStepCount: 49,
      recordedStepCount: 1,
      totalMs: 25,
      stepsTotalMs: 20,
      overheadMs: 5,
      steps: [
        {
          id: "lint",
          script: "lint",
          label: "lint",
          index: 1,
          occurrence: 1,
          durationMs: 20,
          status: 2,
          signal: null,
        },
      ],
    });
  });

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`rejects non-finite timing values instead of serializing ${String(value)}`, () => {
      assert.throws(
        () => serializeTimingSummary({ ...timingResult, totalMs: value }),
        /timing totalMs must be a finite non-negative number/u,
      );
    });
  }

  it("rejects a non-finite step duration instead of silently writing null", () => {
    assert.throws(
      () =>
        serializeTimingSummary({
          ...timingResult,
          plannedStepCount: 1,
          records: [
            {
              id: "lint",
              script: "lint",
              label: "lint",
              index: 1,
              occurrence: 1,
              durationMs: Number.NaN,
              status: 0,
              signal: null,
            },
          ],
        }),
      /timing lint\.durationMs must be a finite non-negative number/u,
    );
  });

  it("atomically replaces the timing artifact with a complete temporary file", () => {
    const directory = mkdtempSync(join(tmpdir(), "quality-timing-"));
    const destination = join(directory, "check-all-timing.json");
    const temporaryPath = `${destination}.fixed.tmp`;
    try {
      writeFileSync(destination, "old artifact\n");
      assert.equal(
        writeTimingSummary(timingResult, {
          destination,
          createTemporaryPath: () => temporaryPath,
          getRecordedAt: () => "2026-08-15T18:37:00.000Z",
        }),
        destination,
      );
      assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), {
        schemaVersion: 1,
        recordedAt: "2026-08-15T18:37:00.000Z",
        outcome: "passed",
        exitCode: 0,
        plannedStepCount: 0,
        recordedStepCount: 0,
        totalMs: 30,
        stepsTotalMs: 10,
        overheadMs: 20,
        steps: [],
      });
      assert.equal(existsSync(temporaryPath), false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  for (const failure of ["write", "rename"]) {
    it(`preserves the previous artifact and removes the temporary file on ${failure} failure`, () => {
      const directory = mkdtempSync(join(tmpdir(), "quality-timing-"));
      const destination = join(directory, "check-all-timing.json");
      const temporaryPath = `${destination}.fixed.tmp`;
      try {
        writeFileSync(destination, "old artifact\n");
        const options = {
          destination,
          createTemporaryPath: () => temporaryPath,
        };
        if (failure === "write") {
          options.writeFile = (path) => {
            writeFileSync(path, "partial");
            throw new Error("write failed");
          };
        } else {
          options.renameFile = () => {
            throw new Error("rename failed");
          };
        }
        assert.throws(
          () => writeTimingSummary(timingResult, options),
          new RegExp(`${failure} failed`, "u"),
        );
        assert.equal(readFileSync(destination, "utf8"), "old artifact\n");
        assert.equal(existsSync(temporaryPath), false);
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    });
  }

  it("prints a partial timing summary before a failed artifact write", () => {
    let clock = 0;
    const output = [];
    const errors = [];
    assert.equal(
      runTimedQualityStepsMain({
        runSteps: () =>
          runTimedQualitySteps({
            steps: ["lint", "format:check", "assets:verify"],
            now: () => {
              clock += 100;
              return clock;
            },
            runSync: (_command, args) => ({
              status: args[1] === "format:check" ? 2 : 0,
              signal: null,
            }),
            stdout: (message) => output.push(message),
            stderr: (message) => errors.push(message),
          }),
        writeSummary: () => {
          throw new Error("disk full");
        },
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      }),
      2,
    );
    assert.deepEqual(output.slice(-4), [
      "[quality-gate] timing summary (failed, 2/3 steps)",
      "  01/3 lint 0.1s exit=0",
      "  02/3 format:check 0.1s exit=2",
      "[quality-gate] total 0.6s outcome=failed exit=2",
    ]);
    assert.deepEqual(errors, ["[quality-gate] unable to write timing summary: disk full"]);
  });

  it("fails closed with exit 74 when green steps cannot write the artifact", () => {
    const errors = [];
    assert.equal(
      runTimedQualityStepsMain({
        runSteps: () => timingResult,
        writeSummary: () => {
          throw new Error("disk full");
        },
        stdout: () => {},
        stderr: (message) => errors.push(message),
      }),
      TIMING_ARTIFACT_EXIT_CODE,
    );
    assert.deepEqual(errors, ["[quality-gate] unable to write timing summary: disk full"]);
  });

  it("preserves a quality-step failure when writing its artifact also fails", () => {
    assert.equal(
      runTimedQualityStepsMain({
        runSteps: () => ({ ...timingResult, exitCode: 2 }),
        writeSummary: () => {
          throw new Error("disk full");
        },
        stdout: () => {},
        stderr: () => {},
      }),
      2,
    );
  });
});
