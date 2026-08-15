import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_WASM_EXPORTS } from "./verify-azookey-wasm-parity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerRoot = resolve(root, "apps/cloudflare-worker-server");

// The lazy wrapper method and the wasm export it forwards to are declared in
// two different places, so pin the pair here rather than deriving one from the
// other, which would quietly assert nothing once the export is renamed.
const REQUIRED_CONVERTER_METHODS = ["openLattice"];
const BACKING_WASM_EXPORT = "azookey_lattice_open";

const BUN_PROBE = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const workerRoot = ${JSON.stringify(workerRoot)};
const { createWasmConverter } = await import(pathToFileURL(workerRoot + "/src/azookey.ts").href);
const wasmBytes = readFileSync(workerRoot + "/wasm/azookey.wasm");
const dictionaryGzip = readFileSync(workerRoot + "/public/azookey/system.azkdict.gz");
const module = new WebAssembly.Module(wasmBytes);
const fetcher = (input) => {
  if (typeof input === "string" && input.endsWith("/azookey/system.azkdict.gz")) {
    return Promise.resolve(new Response(dictionaryGzip, { status: 200 }));
  }
  return Promise.reject(new Error("unexpected fetch"));
};
const converter = createWasmConverter(module, "/azookey/system.azkdict.gz", fetcher);
await converter.warmup?.();
const names = ${JSON.stringify(REQUIRED_CONVERTER_METHODS)};
const payload = Object.fromEntries(names.map((name) => [name, typeof converter[name]]));
console.log(JSON.stringify(payload));
`;

describe("worker one-completion probe", () => {
  it("exposes openLattice on the warmed lazy converter", () => {
    assert.ok(
      REQUIRED_WASM_EXPORTS.includes(BACKING_WASM_EXPORT),
      `${BACKING_WASM_EXPORT} is no longer a required wasm export`,
    );
    const result = spawnSync("bun", ["-e", BUN_PROBE], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    for (const name of REQUIRED_CONVERTER_METHODS) {
      assert.equal(payload[name], "function", `lazy converter is missing ${name}`);
    }
  });
});
