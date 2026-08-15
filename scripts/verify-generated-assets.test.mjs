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
      "334375e6442c3be496a9cf90c21c59fcdbd4ff96560805341333ba1b881c969b",
    );
    assert.equal(
      result.vibratoGlueJs.sha256,
      "e094326c1f0d142882da0a64b272adfc1e5b24eff9b91a02ab531ff9dba96b1e",
    );
    assert.equal(
      result.vibratoGlueDts.sha256,
      "cea5a43822058c77e63b09820ea921acaad18efff5d23cc025bc43b1ef6f4aef",
    );
    assert.equal(
      result.vibratoGlueBgDts.sha256,
      "6cf8b66a1bb3e1989bdd4a042f3f9d40a09f4523a3b08c600727e735a053bdea",
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
