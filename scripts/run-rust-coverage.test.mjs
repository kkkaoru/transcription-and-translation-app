import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  acquireCoverageLock,
  MINIMUM_FREE_BYTES,
  main,
  parseChangedLines,
  parseRunnerArguments,
  resolveManifestPath,
  verifyChangedLineCoverage,
} from "./run-rust-coverage.mjs";

const sufficientBytes = BigInt(MINIMUM_FREE_BYTES + 1024);
const noCleanup = () => Promise.resolve({ removed: [], skipped: [] });
const uniqueLock = () => join(tmpdir(), `kotoba-rust-coverage-test-${randomUUID()}.lock`);

describe("runRustCoverage", () => {
  it("places coverage build artifacts outside the repository and removes them", async () => {
    let targetDirectory = "";
    const exitCode = await main(["packages/azookey-rust/Cargo.toml"], {
      commandOverride:
        'require("node:fs").writeFileSync(require("node:path").join(process.env.CARGO_TARGET_DIR, "artifact"), "generated")',
      onTargetDirectory: (path) => {
        targetDirectory = path;
      },
      cleanup: noCleanup,
      availableBytes: sufficientBytes,
      lockDirectory: uniqueLock(),
    });

    assert.equal(exitCode, 0);
    assert.match(targetDirectory, /kotoba-rust-coverage-/u);
    assert.equal(existsSync(targetDirectory), false);
  });

  it("removes the temporary target after a failed coverage command", async () => {
    let targetDirectory = "";
    const exitCode = await main(["apps/native/Cargo.toml"], {
      commandOverride: "process.exit(7)",
      onTargetDirectory: (path) => {
        targetDirectory = path;
      },
      cleanup: noCleanup,
      availableBytes: sufficientBytes,
      lockDirectory: uniqueLock(),
    });

    assert.equal(exitCode, 7);
    assert.equal(existsSync(targetDirectory), false);
  });

  it("cleans old artifacts and rejects a volume below the 12 GiB floor before compiling", async () => {
    let cleanupCalls = 0;
    let targetDirectory = "";

    await assert.rejects(
      main(["apps/native/Cargo.toml"], {
        commandOverride: "process.exit(0)",
        onTargetDirectory: (path) => {
          targetDirectory = path;
        },
        cleanup: () => {
          cleanupCalls += 1;
          return Promise.resolve({ removed: [], skipped: [] });
        },
        availableBytes: BigInt(MINIMUM_FREE_BYTES - 1),
        lockDirectory: uniqueLock(),
      }),
      /requires at least 12 GiB free/u,
    );

    assert.equal(cleanupCalls, 1);
    assert.equal(targetDirectory, "");
  });

  it("serializes callers with one shared coverage lock", async () => {
    const lockDirectory = uniqueLock();
    const release = await acquireCoverageLock(lockDirectory);

    await assert.rejects(acquireCoverageLock(lockDirectory, 0), /shared Rust coverage lock/u);

    await release();
    assert.equal(existsSync(lockDirectory), false);
  });

  it("parses the threshold options without forwarding them to cargo", () => {
    const parsed = parseRunnerArguments([
      "crates/parapper-engine/Cargo.toml",
      "--changed-lines=95",
      "--changed-path=crates/parapper-engine/src",
      "--show-missing-lines",
    ]);

    assert.equal(parsed.changedLinesMinimum, 95);
    assert.deepEqual(parsed.changedPaths, ["crates/parapper-engine/src"]);
    assert.deepEqual(parsed.cargoArguments, ["--show-missing-lines"]);
  });

  it("enforces at least 95 percent aggregate executable changed-line coverage", () => {
    const source = resolve(tmpdir(), "coverage-fixture.rs");
    const changedLines = new Map([
      [source, new Set(Array.from({ length: 20 }, (_, index) => index + 10))],
    ]);
    const passingLcov = `SF:${source}\n${Array.from(
      { length: 20 },
      (_, index) => `DA:${index + 10},${index === 19 ? 0 : 1}`,
    ).join("\n")}\nend_of_record\n`;
    const failingLcov = passingLcov.replace("DA:28,1", "DA:28,0");

    const result = verifyChangedLineCoverage({
      lcovContent: passingLcov,
      changedLines,
      minimum: 95,
    });
    assert.equal(result.percentage, 95);
    assert.throws(
      () =>
        verifyChangedLineCoverage({
          lcovContent: failingLcov,
          changedLines,
          minimum: 95,
        }),
      /below 95\.00%/u,
    );
  });

  it("parses added hunk lines and rejects missing changed Rust sources", () => {
    const changed = parseChangedLines(
      "+++ apps/native/src/new_pipeline.rs\n@@ -0,0 +4,3 @@\n+one\n+two\n+three\n",
    );
    const source = resolve("apps/native/src/new_pipeline.rs");

    assert.deepEqual([...changed.get(source)], [4, 5, 6]);
    assert.throws(
      () =>
        verifyChangedLineCoverage({
          lcovContent: "",
          changedLines: changed,
          minimum: 95,
        }),
      /missing changed source apps\/native\/src\/new_pipeline\.rs/u,
    );
    assert.doesNotThrow(() =>
      verifyChangedLineCoverage({
        lcovContent: "",
        changedLines: new Map([[resolve("crates/example/src/tests.rs"), new Set([1, 2])]]),
        minimum: 95,
      }),
    );
  });

  it("rejects missing and out-of-repository manifests", () => {
    assert.throws(() => resolveManifestPath("missing/Cargo.toml"), /must exist inside/u);
    assert.throws(() => resolveManifestPath("../../Cargo.toml"), /must exist inside/u);
  });
});
