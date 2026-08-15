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

    assert.match(workspace.scripts["mcp:cloudflare"], /setup-cursor-cloudflare-mcp/);
    for (const scriptName of ["build", "sidecar:build", "gateway:build", "clean:build"]) {
      assert.match(workspace.scripts[scriptName], new RegExp(cleanup));
    }
    assert.match(workspace.scripts["clean:build"], /--prune-rust/);
    assert.match(workspace.scripts["clean:build:rust"], /--prune-rust/);
    assert.doesNotMatch(workspace.scripts["sidecar:build"], /--prune-rust/);
    for (const scriptName of ["build", "tauri:build", "tauri:build:release"]) {
      assert.match(desktop.scripts[scriptName], new RegExp(cleanup));
    }
    // azookey-compare is a standalone Next.js app; it must not run the
    // monorepo desktop/sidecar cleanup as part of its own build.
    assert.doesNotMatch(comparison.scripts.build, new RegExp(cleanup));
    for (const scriptName of ["build", "build:msi"]) {
      assert.match(parapper.scripts[scriptName], new RegExp(cleanup));
      assert.doesNotMatch(parapper.scripts[scriptName], /--prune-rust/);
    }
    for (const scriptName of ["tauri:build", "tauri:build:release"]) {
      assert.doesNotMatch(desktop.scripts[scriptName], /--prune-rust/);
    }
    assert.match(workspace.scripts["test:build-cleanup"], /node --test/);
  });

  it("keeps --prune-rust off every path reachable from tauri:build", async () => {
    const readJson = async (relativePath) =>
      JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"));
    const workspace = await readJson("package.json");
    const desktop = await readJson("apps/desktop/package.json");
    const parapper = await readJson("packages/parapper-asr/package.json");
    const desktopTauri = await readJson("apps/desktop/src-tauri/tauri.conf.json");
    const parapperTauri = await readJson("packages/parapper-asr/src-tauri/tauri.conf.json");
    const scriptsByPackage = {
      workspace: workspace.scripts,
      desktop: desktop.scripts,
      parapper: parapper.scripts,
    };
    const pruneRust = /--prune-rust/;
    const visitedScripts = new Set();
    const visitedFiles = new Set();
    const queue = [];

    const enqueueScript = (scope, name) => {
      const command = scriptsByPackage[scope]?.[name];
      assert.equal(typeof command, "string", `${scope}:${name} must be a script command`);
      const key = `${scope}:${name}`;
      if (visitedScripts.has(key)) return;
      visitedScripts.add(key);
      queue.push({ kind: "script", scope, name, command });
    };

    const enqueueFile = (relativePath, reason) => {
      const normalized = relativePath.replace(/^(?:\.\.\/)+/, "");
      assert.match(normalized, /^scripts\//, `unexpected script path: ${relativePath}`);
      if (visitedFiles.has(normalized)) return;
      visitedFiles.add(normalized);
      queue.push({ kind: "file", relativePath: normalized, reason });
    };

    const followCommand = (command) => {
      for (const match of command.matchAll(
        /(?:^|[\s;&|])(?:bun|npm|pnpm|yarn)(?:\s+--[^\s]+)*\s+run\s+([^\s&|;]+)/g,
      )) {
        const target = match[1];
        if (target.startsWith("scripts/")) {
          enqueueFile(target, command);
          continue;
        }
        if (scriptsByPackage.workspace[target]) {
          enqueueScript("workspace", target);
        }
      }

      for (const match of command.matchAll(
        /--filter=@caption-bridge\/desktop\s+run\s+([^\s&|;]+)/g,
      )) {
        enqueueScript("desktop", match[1]);
      }

      for (const match of command.matchAll(
        /(?:^|[\s;&|])node\s+((?:\.\.\/)*scripts\/[^\s]+\.(?:mjs|js|ts))/g,
      )) {
        enqueueFile(match[1], command);
      }
    };

    for (const name of ["tauri:build", "tauri:build:release", "build:app"]) {
      enqueueScript("workspace", name);
    }
    for (const name of ["tauri:build", "tauri:build:release"]) {
      enqueueScript("desktop", name);
    }

    while (queue.length > 0) {
      const item = queue.shift();
      if (item.kind === "script") {
        assert.doesNotMatch(
          item.command,
          pruneRust,
          `${item.scope}:${item.name} must not prune Rust caches on the tauri:build path`,
        );
        followCommand(item.command);

        if (
          item.scope === "desktop" &&
          (item.name === "tauri:build" || item.name === "tauri:build:release")
        ) {
          // beforeBuildCommand runs in apps/desktop, so resolve `bun run build` there.
          assert.match(desktopTauri.build.beforeBuildCommand, /\bbun run build\b/);
          assert.doesNotMatch(desktopTauri.build.beforeBuildCommand, pruneRust);
          enqueueScript("desktop", "build");
        }
        continue;
      }

      const source = await readFile(join(repositoryRoot, item.relativePath), "utf8");
      // The cleanup implementation defines --prune-rust; app-build callers must not pass it.
      if (item.relativePath !== "scripts/clean-build-artifacts.mjs") {
        assert.doesNotMatch(
          source,
          pruneRust,
          `${item.relativePath} (via ${item.reason}) must not pass --prune-rust`,
        );
      }

      if (
        item.relativePath === "scripts/build-sidecar.ts" &&
        /\[process\.execPath,\s*"run",\s*"build"\]/.test(source) &&
        /parapperDir|packages[\\/"'`]parapper-asr/.test(source)
      ) {
        enqueueScript("parapper", "build");
      }
      if (/--filter=@caption-bridge\/desktop[\s\S]{0,80}tauri:build:release/.test(source)) {
        enqueueScript("desktop", "tauri:build:release");
      } else if (/--filter=@caption-bridge\/desktop[\s\S]{0,80}tauri:build/.test(source)) {
        enqueueScript("desktop", "tauri:build");
      }
    }

    assert.match(desktopTauri.build.beforeBuildCommand, /\bbun run build\b/);
    assert.match(parapperTauri.build.beforeBuildCommand, /\bbun run build\b/);
    assert.doesNotMatch(desktopTauri.build.beforeBuildCommand, pruneRust);
    assert.doesNotMatch(parapperTauri.build.beforeBuildCommand, pruneRust);

    assert.ok(
      visitedScripts.has("workspace:sidecar:build"),
      "tauri:build must reach sidecar:build",
    );
    assert.ok(
      visitedFiles.has("scripts/build-sidecar.ts"),
      "sidecar:build must reach build-sidecar.ts",
    );
    assert.ok(
      visitedScripts.has("desktop:tauri:build"),
      "tauri:build must reach desktop tauri:build",
    );
    assert.ok(visitedScripts.has("desktop:build"), "desktop tauri:build must reach desktop build");
    assert.ok(
      visitedScripts.has("parapper:build"),
      "tauri:build must reach parapper build via sidecar",
    );
    assert.ok(
      !visitedScripts.has("workspace:clean:build"),
      "explicit clean:build must stay off the app path",
    );
    assert.ok(
      !visitedScripts.has("workspace:clean:build:rust"),
      "explicit clean:build:rust must stay off the app path",
    );
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
      activeProcesses: ["cargo test --manifest-path packages/parapper-asr/src-tauri/Cargo.toml"],
    });

    assert.equal(existsSync(staleBunBuild), true);
    assert.equal(existsSync(frontendOutput), true);
    assert.equal(existsSync(rustBundle), true);
    assert.equal(result.removed.length, 0);
    assert.match(result.skipped[0], /deferred/);
  });

  it("preserves a live azookey-compare Next.js output while cleaning other artifacts", async () => {
    const root = await createRoot();
    const comparisonOutput = await createFile(root, "apps/azookey-compare/.next/server/app.js");
    const frontendOutput = await createFile(root, "apps/desktop/dist/index.js");

    const result = await cleanBuildArtifacts({
      root,
      processCommands: [
        `node ${join(root, "apps/azookey-compare/node_modules/next/dist/bin/next")} dev --hostname 127.0.0.1`,
      ],
      preservedDirectories: new Set(["apps/azookey-compare/.next"]),
    });

    assert.equal(existsSync(comparisonOutput), true);
    assert.equal(existsSync(frontendOutput), false);
    assert.equal(result.removed.includes("apps/desktop/dist"), true);
    assert.match(
      result.skipped.find((entry) => entry.includes("apps/azookey-compare/.next")) ?? "",
      /live local server/,
    );
  });
});
