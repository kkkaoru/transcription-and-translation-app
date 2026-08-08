import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bundledRuntimeRpaths,
  isMachineLocalRpath,
  parseOtoolRpaths,
} from "./macos-sidecar-binary.mjs";

describe("macOS sidecar binary finalize", () => {
  it("parses LC_RPATH entries from otool output", () => {
    const output = `
          cmd LC_RPATH
      cmdsize 128
         path /Users/me/.tools/kotoba-llama.cpp/build-kotoba/bin (offset 12)
          cmd LC_RPATH
      cmdsize 48
         path @executable_path/llama-runtime (offset 12)
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name @rpath/libllama.0.dylib (offset 24)
`;
    assert.deepEqual(parseOtoolRpaths(output), [
      "/Users/me/.tools/kotoba-llama.cpp/build-kotoba/bin",
      "@executable_path/llama-runtime",
    ]);
  });

  it("treats only filesystem paths as machine-local rpaths", () => {
    assert.equal(isMachineLocalRpath("/Users/me/.tools/build/bin"), true);
    assert.equal(isMachineLocalRpath("C:\\tools\\build\\bin"), true);
    assert.equal(isMachineLocalRpath("@executable_path/../Resources/llama-runtime"), false);
    assert.equal(isMachineLocalRpath("@loader_path/."), false);
  });

  it("keeps both debug-adjacent and app-bundle runtime rpaths", () => {
    assert.deepEqual(bundledRuntimeRpaths("llama-runtime"), [
      "@executable_path/llama-runtime",
      "@executable_path/../Resources/llama-runtime",
    ]);
  });
});
