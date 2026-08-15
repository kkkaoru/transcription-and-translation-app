import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ciGateExclusions,
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

  it("runs the wasm parity suite from the local test:build-cleanup gate", () => {
    const command = packageJson.scripts["test:build-cleanup"];
    assert.match(
      command,
      /scripts\/verify-azookey-wasm-parity\.test\.mjs/,
      "check:all must execute wasm parity, not only keep the script on disk",
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

  it("requires every platform-specific exclusion to exist and explain itself", () => {
    for (const [command, reason] of ciGateExclusions) {
      assert.match(reason, /\S/u, `${command} needs a reason`);
      assert.equal(extractCiGateCommands(workflow).includes(command), true, `${command} is stale`);
    }
  });
});
