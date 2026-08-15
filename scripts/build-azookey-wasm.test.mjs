import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  AZOOKEY_WASM_SOURCE_DIGEST_PATH,
  calculateAzookeyWasmSourceDigest,
  reproducibleRustFlags,
} from "./build-azookey-wasm.mjs";

const withSourceRepository = (callback) => {
  const root = mkdtempSync(join(tmpdir(), "azookey-source-digest-"));
  const write = (path, content) => {
    const absolutePath = join(root, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  };
  try {
    execFileSync("git", ["init", "--quiet", root]);
    write("packages/azookey-rust/src/lib.rs", "pub fn convert() {}\n");
    write("packages/azookey-wasm/src/lib.rs", "pub fn wasm() {}\n");
    write("packages/azookey-rust/Cargo.lock", "rust lock\n");
    write("packages/azookey-wasm/Cargo.lock", "wasm lock\n");
    write("rust-toolchain.toml", '[toolchain]\nchannel = "1.97.1"\n');
    write("scripts/build-azookey-wasm.mjs", "export const build = true;\n");
    write(AZOOKEY_WASM_SOURCE_DIGEST_PATH, "must not hash itself\n");
    execFileSync("git", ["-C", root, "add", "."]);
    return callback({ root, write });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

describe("AzooKey WASM reproducible build", () => {
  it("remaps both the source checkout and Rust sysroot", () => {
    const repositoryRoot = realpathSync(".");
    const rustSysroot = realpathSync(`${process.env.HOME}/.rustup`);
    assert.deepEqual(reproducibleRustFlags({ repositoryRoot, rustSysroot }), [
      `--remap-path-prefix=${repositoryRoot}=.`,
      `--remap-path-prefix=${rustSysroot}=rust-toolchain`,
    ]);
  });

  it("automatically includes generator and new tracked files but excludes its sidecar", () => {
    withSourceRepository(({ root, write }) => {
      const before = calculateAzookeyWasmSourceDigest(root);
      assert.equal(before.paths.includes("scripts/build-azookey-wasm.mjs"), true);
      assert.equal(before.paths.includes(AZOOKEY_WASM_SOURCE_DIGEST_PATH), false);

      write(AZOOKEY_WASM_SOURCE_DIGEST_PATH, "changed sidecar\n");
      assert.equal(calculateAzookeyWasmSourceDigest(root).sha256, before.sha256);

      write("scripts/build-azookey-wasm.mjs", "export const build = false;\n");
      const changedGenerator = calculateAzookeyWasmSourceDigest(root);
      assert.notEqual(changedGenerator.sha256, before.sha256);

      write("packages/azookey-rust/src/new_module.rs", "pub fn added() {}\n");
      execFileSync("git", ["-C", root, "add", "packages/azookey-rust/src/new_module.rs"]);
      const after = calculateAzookeyWasmSourceDigest(root);
      assert.equal(after.paths.includes("packages/azookey-rust/src/new_module.rs"), true);
      assert.notEqual(after.sha256, changedGenerator.sha256);
    });
  });

  it("rejects an untracked crate source before generating a misleading digest", () => {
    withSourceRepository(({ root, write }) => {
      write("packages/azookey-wasm/src/untracked.rs", "pub fn forgotten() {}\n");
      assert.throws(
        () => calculateAzookeyWasmSourceDigest(root),
        /untracked AzooKey WASM source inputs.*git add.*untracked\.rs/su,
      );
    });
  });
});
