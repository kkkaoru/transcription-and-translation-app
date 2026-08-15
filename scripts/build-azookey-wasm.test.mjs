import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { describe, it } from "node:test";
import { reproducibleRustFlags } from "./build-azookey-wasm.mjs";

describe("AzooKey WASM reproducible build flags", () => {
  it("remaps both the source checkout and Rust sysroot", () => {
    const repositoryRoot = realpathSync(".");
    const rustSysroot = realpathSync(`${process.env.HOME}/.rustup`);
    assert.deepEqual(reproducibleRustFlags({ repositoryRoot, rustSysroot }), [
      `--remap-path-prefix=${repositoryRoot}=.`,
      `--remap-path-prefix=${rustSysroot}=rust-toolchain`,
    ]);
  });
});
