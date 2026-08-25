import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { REQUIRED_WASM_EXPORTS } from "./verify-azookey-wasm-parity.mjs";
import {
  assertAzookeyWasmSourceDigest,
  verifyGeneratedAssets,
} from "./verify-generated-assets.mjs";

describe("checked-in runtime assets", () => {
  it("gives the exact regeneration command when the WASM source digest is stale", () => {
    assert.throws(
      () => assertAzookeyWasmSourceDigest({ recorded: "a".repeat(64), current: "b".repeat(64) }),
      /AzooKey WASM is stale:.*regenerate it with `bun --filter=@caption-bridge\/cloudflare-worker-server run build:wasm`/u,
    );
  });

  it("keeps every generated copy byte-identical and valid", () => {
    const result = verifyGeneratedAssets();
    assert.equal(
      result.vibratoDictionary.sha256,
      "82a6da70bb4a17be70f20ff44f650f9ad1d2b0b4fcb2f39c17fc797f92d0ab75",
    );
    assert.equal(
      result.vibratoWasm.sha256,
      "5100c6dac6bf81543fb0a2067b566bf1d78a6403924a2743e7d058d663320a73",
    );
    assert.equal(
      result.vibratoGlueJs.sha256,
      "17706b5d2c0d14768df95b5b3f3400ecd4f47145ae25ba85479db57569f3c137",
    );
    assert.equal(
      result.vibratoGlueDts.sha256,
      "2fd1c77ff5354ddaa04662ab696f0adf7e4f4a9d3dd592fd215ba632847a52d3",
    );
    assert.equal(
      result.vibratoGlueBgDts.sha256,
      "da4d611ff92f4b75230db64dbb84b1b151b330bdf6736338fd3d7d3a92c58042",
    );
    assert.equal(
      result.vibratoCopying.sha256,
      "81266cd4d1808e259b468c7488d658d733c089d4c346a48b9876fa2504a23b46",
    );
    assert.equal(
      result.vibratoNotice.sha256,
      "8f76551acd5ba10116d61a2fea60bcc484906c836e86b7846cb175d1492a086b",
    );
    assert.equal(
      result.azookeyDictionary.sha256,
      "84f605a5c76e09480ef1a0a02d91982fb8c9426a8a7a18fb64d9f27210641b22",
    );
    assert.ok(result.azookeyWasm.bytes.byteLength > 0);
    const module = new WebAssembly.Module(result.azookeyWasm.bytes);
    const exportNames = new Set(WebAssembly.Module.exports(module).map(({ name }) => name));
    for (const name of REQUIRED_WASM_EXPORTS) {
      assert.equal(exportNames.has(name), true, `assets:verify must require ${name}`);
    }
  });
});
