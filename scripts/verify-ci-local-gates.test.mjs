import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertBuildCleanupTestManifest,
  assertCoverageGateParity,
  assertFmtGateParity,
  assertLintGateParity,
  assertTypecheckGateParity,
  buildCleanupTestExclusions,
  ciCoverageExclusions,
  ciFmtExclusions,
  ciGateExclusions,
  ciLintExclusions,
  ciTypecheckExclusions,
  extractCiGateCommands,
  extractLocalGateScripts,
  verifyCiLocalGateParity,
} from "./verify-ci-local-gates.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

describe("CI and local quality-gate parity", () => {
  it("keeps the local full gate a superset of every classified CI gate", () => {
    assert.deepEqual(verifyCiLocalGateParity({ workflow, packageJson }), {
      missingLocalScripts: [],
      unknownCiCommands: [],
      staleExclusions: [],
    });
  });

  it("maps direct CI Cargo commands to their local script equivalents", () => {
    const ciCommands = extractCiGateCommands(workflow);
    const localScripts = extractLocalGateScripts(packageJson);

    assert.equal(
      ciCommands.includes(
        "cargo build --locked --manifest-path packages/vibrato/wasm/Cargo.toml --target wasm32-unknown-unknown --release",
      ),
      true,
    );
    assert.equal(localScripts.includes("rust:vibrato:wasm:build"), true);
    assert.equal(localScripts.includes("parapper:rust:test"), true);
  });

  it("fails closed when CI adds a local script that is not in the full gate", () => {
    const result = verifyCiLocalGateParity({
      workflow: workflow.replace(
        "      - run: bun run worker:typecheck\n",
        "      - run: bun run worker:typecheck\n      - run: bun run future:quality-gate\n",
      ),
      packageJson,
    });
    assert.deepEqual(result.missingLocalScripts, [
      "future:quality-gate (CI: bun run future:quality-gate)",
    ]);
  });

  it("reports a classified CI script omitted from the local full gate", () => {
    const withoutLint = structuredClone(packageJson);
    withoutLint.scripts["check:all:unlocked"] = "bun run format:check";
    assert.throws(
      () => verifyCiLocalGateParity({ workflow, packageJson: withoutLint }),
      /timed quality-step runner/,
    );
  });

  it("runs every scripts test exactly through the local test:build-cleanup gate", () => {
    assert.equal(buildCleanupTestExclusions.size, 0);
    assert.doesNotThrow(() =>
      assertBuildCleanupTestManifest({
        command: packageJson.scripts["test:build-cleanup"],
        scriptsDirectory: resolve(root, "scripts"),
      }),
    );
  });

  it("names both an unlisted test and a listed file missing from disk", () => {
    assert.throws(
      () =>
        assertBuildCleanupTestManifest({
          command: "node --test scripts/listed-but-deleted.test.mjs",
          discoveredTests: ["scripts/new-but-unlisted.test.mjs"],
        }),
      (error) => {
        assert.match(
          error.message,
          /unlisted scripts tests: scripts\/new-but-unlisted\.test\.mjs/u,
        );
        assert.match(
          error.message,
          /listed scripts tests missing from disk: scripts\/listed-but-deleted\.test\.mjs/u,
        );
        return true;
      },
    );
  });

  it("requires the local gate to keep the post-build assets:verify after worker:typecheck", () => {
    const localScripts = extractLocalGateScripts(packageJson);
    const first = localScripts.indexOf("assets:verify");
    const second = localScripts.indexOf("assets:verify", first + 1);
    const workerTypecheck = localScripts.indexOf("worker:typecheck");
    assert.notEqual(first, -1);
    assert.notEqual(second, -1);
    assert.ok(first < workerTypecheck);
    assert.ok(workerTypecheck < second);
  });

  it("runs every coverage gate in CI as well as locally", () => {
    assertCoverageGateParity({ packageJson, workflow });
  });

  it("names a coverage gate that CI does not run", () => {
    assert.throws(
      () =>
        assertCoverageGateParity({
          packageJson: { scripts: { "lonely:test:coverage": "vitest run --coverage" } },
          workflow: "      - run: bun run typecheck\n",
        }),
      (error) => {
        assert.match(error.message, /coverage gates missing from CI: lonely:test:coverage/u);
        return true;
      },
    );
  });

  it("names a CI coverage gate with no local script", () => {
    assert.throws(
      () =>
        assertCoverageGateParity({
          packageJson: { scripts: {} },
          workflow: "      - run: bun run ghost:test:coverage\n",
        }),
      (error) => {
        assert.match(error.message, /CI coverage gates with no local script: ghost:test:coverage/u);
        return true;
      },
    );
  });

  it("requires every coverage exclusion to explain itself", () => {
    for (const [script, reason] of ciCoverageExclusions) {
      assert.match(reason, /\S/u, `${script} needs a reason`);
    }
  });

  it("runs every typecheck gate in CI as well as locally", () => {
    assertTypecheckGateParity({ packageJson, workflow });
  });

  it("names a typecheck gate that CI does not run", () => {
    assert.throws(
      () =>
        assertTypecheckGateParity({
          packageJson: { scripts: { "lonely:typecheck": "tsc -b" } },
          workflow: "      - run: bun run lint\n",
        }),
      (error) => {
        assert.match(error.message, /typecheck gates missing from CI: lonely:typecheck/u);
        return true;
      },
    );
  });

  it("names a CI typecheck gate with no local script", () => {
    assert.throws(
      () =>
        assertTypecheckGateParity({
          packageJson: { scripts: {} },
          workflow: "      - run: bun run ghost:typecheck\n",
        }),
      (error) => {
        assert.match(error.message, /CI typecheck gates with no local script: ghost:typecheck/u);
        return true;
      },
    );
  });

  it("requires every typecheck exclusion to explain itself", () => {
    for (const [script, reason] of ciTypecheckExclusions) {
      assert.match(reason, /\S/u, `${script} needs a reason`);
    }
  });

  it("runs every lint gate in CI as well as locally", () => {
    assertLintGateParity({ packageJson, workflow });
  });

  it("names a lint gate that CI does not run", () => {
    assert.throws(
      () =>
        assertLintGateParity({
          packageJson: { scripts: { "lonely:lint": "biome check ." } },
          workflow: "      - run: bun run typecheck\n",
        }),
      (error) => {
        assert.match(error.message, /lint gates missing from CI: lonely:lint/u);
        return true;
      },
    );
  });

  it("names a CI lint gate with no local script", () => {
    assert.throws(
      () =>
        assertLintGateParity({
          packageJson: { scripts: {} },
          workflow: "      - run: bun run ghost:lint\n",
        }),
      (error) => {
        assert.match(error.message, /CI lint gates with no local script: ghost:lint/u);
        return true;
      },
    );
  });

  it("requires every lint exclusion to explain itself", () => {
    for (const [script, reason] of ciLintExclusions) {
      assert.match(reason, /\S/u, `${script} needs a reason`);
    }
  });

  it("runs every fmt gate in CI as well as locally", () => {
    assertFmtGateParity({ packageJson, workflow });
  });

  it("names a fmt gate that CI does not run", () => {
    assert.throws(
      () =>
        assertFmtGateParity({
          packageJson: { scripts: { "lonely:fmt": "cargo fmt -- --check" } },
          workflow: "      - run: bun run lint\n",
        }),
      (error) => {
        assert.match(error.message, /fmt gates missing from CI: lonely:fmt/u);
        return true;
      },
    );
  });

  it("names a CI fmt gate with no local script", () => {
    assert.throws(
      () =>
        assertFmtGateParity({
          packageJson: { scripts: {} },
          workflow: "      - run: bun run ghost:fmt\n",
        }),
      (error) => {
        assert.match(error.message, /CI fmt gates with no local script: ghost:fmt/u);
        return true;
      },
    );
  });

  it("requires every fmt exclusion to explain itself", () => {
    for (const [script, reason] of ciFmtExclusions) {
      assert.match(reason, /\S/u, `${script} needs a reason`);
    }
  });

  it("requires every platform-specific exclusion to exist and explain itself", () => {
    for (const [command, reason] of ciGateExclusions) {
      assert.match(reason, /\S/u, `${command} needs a reason`);
      assert.equal(extractCiGateCommands(workflow).includes(command), true, `${command} is stale`);
    }
  });
});
