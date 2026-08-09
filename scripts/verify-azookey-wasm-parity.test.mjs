import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  assertCompareDoesNotShipAzookeyAssets,
  assertInferenceCompareShareWorkerAssets,
  COMPARE_MUST_NOT_SHIP,
  createPortableConverter,
  EXPECTED_DICT_SHA256,
  loadWorkerAzookeyAssets,
  repositoryRoot,
  SPOT_CHECK_CASES,
  sha256,
  verifyAzookeyWasmParity,
  WORKER_DICT_RELATIVE_PATH,
  WORKER_WASM_RELATIVE_PATH,
} from "./verify-azookey-wasm-parity.mjs";

describe("AzooKey worker wasm/dict portable ABI parity", () => {
  it("converts きょうはいいてんき with the real worker-server wasm and pinned dict hash", () => {
    const assets = loadWorkerAzookeyAssets();
    assert.equal(assets.dictSha256, EXPECTED_DICT_SHA256);
    assert.equal(assets.wasmBytes[0], 0x00);
    assert.equal(assets.wasmBytes[1], 0x61);
    assert.equal(assets.wasmBytes[2], 0x73);
    assert.equal(assets.wasmBytes[3], 0x6d);
    assert.ok(assets.wasmBytes.byteLength > 100_000);
    assert.equal(sha256(readFileSync(assets.wasmPath)), assets.wasmSha256);
    assert.equal(sha256(readFileSync(assets.dictPath)), assets.dictSha256);
    assert.ok(assets.wasmPath.endsWith(WORKER_WASM_RELATIVE_PATH));
    assert.ok(assets.dictPath.endsWith(WORKER_DICT_RELATIVE_PATH));

    const convert = createPortableConverter(assets.wasmBytes, assets.dictGz);
    assert.equal(convert("きょうはいいてんき"), "今日はいい天気");
    for (const [input, expected] of SPOT_CHECK_CASES) {
      assert.equal(convert(input), expected);
    }
  });

  it("lets inference and compare share the same worker-server artifacts without copying them", () => {
    assertCompareDoesNotShipAzookeyAssets(repositoryRoot);
    assertInferenceCompareShareWorkerAssets(repositoryRoot);
    for (const relativePath of COMPARE_MUST_NOT_SHIP) {
      assert.equal(relativePath.startsWith("apps/azookey-compare/"), true);
    }
    const result = verifyAzookeyWasmParity();
    assert.equal(result.ok, true);
    assert.equal(result.dictSha256, EXPECTED_DICT_SHA256);
    assert.equal(result.conversions[0]?.input, "きょうはいいてんき");
    assert.equal(result.conversions[0]?.output, "今日はいい天気");
  });
});
