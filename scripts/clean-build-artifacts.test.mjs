import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanBuildArtifacts } from "./clean-build-artifacts.mjs";

const temporaryRoots = [];
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const createRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "kotoba-build-cleanup-"));
  temporaryRoots.push(root);
  return root;
};

const createFile = async (root, relativePath) => {
  const file = join(root, relativePath);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "generated");
  return file;
};

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("cleanBuildArtifacts", () => {
  it("removes stale Bun compile files and explicit build output while preserving caches", async () => {
    const root = await createRoot();
    const staleBunBuild = await createFile(root, ".deadbeefdeadbeef-00000000.bun-build");
    const malformedBunBuild = await createFile(root, ".abc-00000000.bun-build");
    const unrelatedHiddenFile = await createFile(root, ".keep-me");
    const nestedBunBuild = await createFile(root, "nested/.deadbeef-00000000.bun-build");
    const frontendOutput = await createFile(root, "apps/desktop/dist/assets/index.js");
    const comparisonOutput = await createFile(root, "apps/azookey-compare/.next/server/app.js");
    const gatewayOutput = await createFile(root, "apps/inference-gateway/dist/index.js");
    const coreOutput = await createFile(root, "packages/inference-server-core/dist/index.js");
    const coverageOutput = await createFile(root, "apps/desktop/coverage/coverage-summary.json");
    const tauriBundle = await createFile(
      root,
      "apps/desktop/src-tauri/target/release/bundle/macos/Kotoba Beacon.app/Contents/Info.plist",
    );
    const parapperBundle = await createFile(
      root,
      "packages/parapper-asr/target/release/bundle/macos/Parapper.app/Contents/Info.plist",
    );
    const parapperWindowsBundle = await createFile(
      root,
      "packages/parapper-asr/target/x86_64-pc-windows-msvc/release/bundle/msi/Parapper.msi",
    );
    const targetCache = await createFile(
      root,
      "apps/desktop/src-tauri/target/release/cache/keep.o",
    );
    const releaseBinary = await createFile(
      root,
      "apps/desktop/src-tauri/target/release/kotoba-beacon",
    );

    await cleanBuildArtifacts({ root });

    for (const removed of [
      staleBunBuild,
      frontendOutput,
      comparisonOutput,
      gatewayOutput,
      coreOutput,
      coverageOutput,
      tauriBundle,
      parapperBundle,
      parapperWindowsBundle,
    ]) {
      assert.equal(existsSync(removed), false, `stale output remains: ${removed}`);
    }
    for (const preserved of [
      malformedBunBuild,
      unrelatedHiddenFile,
      nestedBunBuild,
      targetCache,
      releaseBinary,
    ]) {
      assert.equal(existsSync(preserved), true, `unrelated file was removed: ${preserved}`);
    }
  });

  it("removes stale coverage reports from every workspace package", async () => {
    const root = await createRoot();
    const coverageDirectories = [
      "apps/desktop/coverage",
      "apps/azookey-compare/coverage",
      "apps/inference-gateway/coverage",
      "apps/cloudflare-worker-server/coverage",
      "packages/inference-server-core/coverage",
      "packages/parapper-asr/coverage",
    ];
    const coverageOutputs = await Promise.all(
      coverageDirectories.map((directory) =>
        createFile(root, `${directory}/coverage-summary.json`),
      ),
    );

    await cleanBuildArtifacts({ root });

    for (const output of coverageOutputs) {
      assert.equal(existsSync(output), false, `stale coverage remains: ${output}`);
    }
  });

  it("supports a dry run without deleting any output", async () => {
    const root = await createRoot();
    const staleBunBuild = await createFile(root, ".deadbeefdeadbeef-00000000.bun-build");
    const frontendOutput = await createFile(root, "apps/desktop/dist/assets/index.js");
    const targetCache = await createFile(
      root,
      "apps/desktop/src-tauri/target/release/cache/keep.o",
    );

    await cleanBuildArtifacts({ root, dryRun: true });

    for (const preserved of [staleBunBuild, frontendOutput, targetCache]) {
      assert.equal(existsSync(preserved), true, `dry run removed: ${preserved}`);
    }
  });

  it("supports temporary-only cleanup without touching generated directories", async () => {
    const root = await createRoot();
    const staleBunBuild = await createFile(root, ".deadbeefdeadbeef-00000000.bun-build");
    const frontendOutput = await createFile(root, "apps/desktop/dist/assets/index.js");

    await cleanBuildArtifacts({ root, temporaryOnly: true });

    assert.equal(existsSync(staleBunBuild), false);
    assert.equal(existsSync(frontendOutput), true);
  });

  it("prunes Rust debug/release caches while retaining release runtime files", async () => {
    const root = await createRoot();
    const debugCache = await createFile(root, "apps/desktop/src-tauri/target/debug/deps/old.rlib");
    const libraryTarget = await createFile(
      root,
      "packages/azookey-rust/target/debug/deps/old.rlib",
    );
    const azookeyWasmTarget = await createFile(
      root,
      "packages/azookey-wasm/target/wasm32-unknown-unknown/release/deps/old.rlib",
    );
    const parapperTauriTarget = await createFile(
      root,
      "packages/parapper-asr/src-tauri/target/release/deps/old.rlib",
    );
    const parapperReleaseDeps = await createFile(
      root,
      "packages/parapper-asr/target/release/deps/old.rlib",
    );
    const parapperWindowsReleaseDeps = await createFile(
      root,
      "packages/parapper-asr/target/x86_64-pc-windows-msvc/release/deps/old.rlib",
    );
    const parapperBundle = await createFile(
      root,
      "packages/parapper-asr/target/release/bundle/msi/old.msi",
    );
    const parapperWindowsBundle = await createFile(
      root,
      "packages/parapper-asr/target/x86_64-pc-windows-msvc/release/bundle/msi/old.msi",
    );
    const releaseDeps = await createFile(
      root,
      "apps/desktop/src-tauri/target/release/deps/old.rlib",
    );
    const releaseBinary = await createFile(
      root,
      "apps/desktop/src-tauri/target/release/kotoba-beacon",
    );
    const releaseRuntime = await createFile(
      root,
      "packages/parapper-asr/target/release/macos-runtime/libonnx.dylib",
    );

    await cleanBuildArtifacts({ root, pruneRust: true });

    for (const removed of [
      debugCache,
      libraryTarget,
      azookeyWasmTarget,
      parapperTauriTarget,
      parapperReleaseDeps,
      parapperWindowsReleaseDeps,
      parapperBundle,
      parapperWindowsBundle,
      releaseDeps,
    ]) {
      assert.equal(existsSync(removed), false, `Rust cache remains: ${removed}`);
    }
    for (const retained of [releaseBinary, releaseRuntime]) {
      assert.equal(existsSync(retained), true, `release runtime was removed: ${retained}`);
    }
  });

  it("rejects broad or symlinked roots before removing anything", async () => {
    const root = await createRoot();
    const symlinkRoot = join(root, "link");
    await symlink(root, symlinkRoot, "dir");

    await assert.rejects(() => cleanBuildArtifacts({ root: tmpdir() }), /temporary test directory/);
    await assert.rejects(
      () => cleanBuildArtifacts({ root: "/Applications" }),
      /temporary test directory/,
    );
    await assert.rejects(() => cleanBuildArtifacts({ root: "/" }), /filesystem root/);
    await assert.rejects(() => cleanBuildArtifacts({ root: symlinkRoot }), /real directory/);
  });

  it("is wired into every build entrypoint", async () => {
    const workspace = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    const desktop = JSON.parse(
      await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"),
    );
    const comparison = JSON.parse(
      await readFile(join(repositoryRoot, "apps/azookey-compare/package.json"), "utf8"),
    );
    const parapper = JSON.parse(
      await readFile(join(repositoryRoot, "packages/parapper-asr/package.json"), "utf8"),
    );
    const cleanup = "clean-build-artifacts";

    for (const scriptName of ["build", "sidecar:build", "gateway:build", "clean:build"]) {
      assert.match(workspace.scripts[scriptName], new RegExp(cleanup));
    }
    assert.match(workspace.scripts["clean:build"], /--prune-rust/);
    assert.match(workspace.scripts["sidecar:build"], /--prune-rust/);
    for (const scriptName of ["build", "tauri:build", "tauri:build:release"]) {
      assert.match(desktop.scripts[scriptName], new RegExp(cleanup));
    }
    assert.match(comparison.scripts.build, new RegExp(cleanup));
    for (const scriptName of ["build", "build:msi"]) {
      assert.match(parapper.scripts[scriptName], new RegExp(cleanup));
    }
    for (const scriptName of ["tauri:build", "tauri:build:release"]) {
      assert.match(desktop.scripts[scriptName], /--prune-rust/);
    }
    assert.match(workspace.scripts["test:build-cleanup"], /node --test/);
  });

  it("serializes concurrent cleanup calls for one worktree", async () => {
    const root = await createRoot();
    const staleOutput = await createFile(root, "apps/desktop/dist/index.js");

    const results = await Promise.all(
      Array.from({ length: 4 }, () => cleanBuildArtifacts({ root, pruneRust: true })),
    );

    assert.equal(existsSync(staleOutput), false);
    assert.equal(existsSync(join(root, ".kotoba-build-cleanup.lock")), false);
    assert.equal(results.length, 4);
  });

  it("defers every deletion while a Rust build is active", async () => {
    const root = await createRoot();
    const staleBunBuild = await createFile(root, ".deadbeefdeadbeef-00000000.bun-build");
    const frontendOutput = await createFile(root, "apps/desktop/dist/index.js");
    const rustBundle = await createFile(
      root,
      "packages/parapper-asr/target/release/bundle/msi/old.msi",
    );

    const result = await cleanBuildArtifacts({
      root,
      pruneRust: true,
      activeProcesses: ["cargo test --manifest-path packages/parapper-asr/src-tauri/Cargo.toml"],
    });

    assert.equal(existsSync(staleBunBuild), true);
    assert.equal(existsSync(frontendOutput), true);
    assert.equal(existsSync(rustBundle), true);
    assert.equal(result.removed.length, 0);
    assert.match(result.skipped[0], /deferred/);
  });
});
