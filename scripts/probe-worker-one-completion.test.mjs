import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "scripts/probe-worker-one-completion.mjs"), "utf8");

describe("worker one-completion probe", () => {
  it("exercises the production converter path instead of a stub", () => {
    assert.match(source, /createWasmConverter/);
    assert.match(source, /convertAzookeyMessage/);
    assert.match(source, /openLattice/);
    assert.match(source, /leftContext/);
    assert.match(source, /upstream-failed|modelFallback/);
  });
});
