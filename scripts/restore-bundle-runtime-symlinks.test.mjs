import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyTemplateSymlinks,
  collapseIdenticalLibraries,
  findMacosAppBundles,
  restoreAppBundleRuntimeSymlinks,
} from "./restore-bundle-runtime-symlinks.mjs";

const tempDir = () => mkdtempSync(join(tmpdir(), "restore-runtime-"));

describe("restore bundle runtime symlinks", () => {
  it("reapplies CMake dylib symlink chains from the resource template", () => {
    const root = tempDir();
    const template = join(root, "template");
    const dest = join(root, "dest");
    mkdirSync(template);
    mkdirSync(dest);
    writeFileSync(join(template, "libggml-base.0.17.0.dylib"), "ggml-base");
    symlinkSync("libggml-base.0.17.0.dylib", join(template, "libggml-base.0.dylib"));
    symlinkSync("libggml-base.0.dylib", join(template, "libggml-base.dylib"));
    writeFileSync(join(dest, "libggml-base.0.17.0.dylib"), "ggml-base");
    writeFileSync(join(dest, "libggml-base.0.dylib"), "ggml-base");
    writeFileSync(join(dest, "libggml-base.dylib"), "ggml-base");

    assert.equal(applyTemplateSymlinks(template, dest), 2);
    assert.equal(readlinkSync(join(dest, "libggml-base.0.dylib")), "libggml-base.0.17.0.dylib");
    assert.equal(readlinkSync(join(dest, "libggml-base.dylib")), "libggml-base.0.dylib");
    assert.equal(lstatSync(join(dest, "libggml-base.0.17.0.dylib")).isSymbolicLink(), false);
  });

  it("collapses identical unversioned ONNX copies into a relative symlink", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "libonnxruntime.1.24.4.dylib"), "onnx-bytes");
    writeFileSync(join(dir, "libonnxruntime.dylib"), "onnx-bytes");
    writeFileSync(join(dir, "libsherpa-onnx-c-api.dylib"), "sherpa");

    assert.equal(collapseIdenticalLibraries(dir), 1);
    assert.equal(readlinkSync(join(dir, "libonnxruntime.dylib")), "libonnxruntime.1.24.4.dylib");
    assert.equal(lstatSync(join(dir, "libonnxruntime.1.24.4.dylib")).isSymbolicLink(), false);
    assert.equal(lstatSync(join(dir, "libsherpa-onnx-c-api.dylib")).isSymbolicLink(), false);
  });

  it("restores runtime dirs inside a fake .app and finds macOS bundles", () => {
    const root = tempDir();
    const targetDir = join(root, "target");
    const app = join(targetDir, "release", "bundle", "macos", "Kotoba Beacon.app");
    const resources = join(app, "Contents", "Resources", "llama-runtime");
    const template = join(root, "resources", "llama-runtime");
    mkdirSync(resources, { recursive: true });
    mkdirSync(template, { recursive: true });
    writeFileSync(join(template, "libllama.0.0.1.dylib"), "llama");
    symlinkSync("libllama.0.0.1.dylib", join(template, "libllama.0.dylib"));
    symlinkSync("libllama.0.dylib", join(template, "libllama.dylib"));
    writeFileSync(join(resources, "libllama.0.0.1.dylib"), "llama");
    writeFileSync(join(resources, "libllama.0.dylib"), "llama");
    writeFileSync(join(resources, "libllama.dylib"), "llama");

    assert.deepEqual(findMacosAppBundles(targetDir), [app]);
    assert.deepEqual(restoreAppBundleRuntimeSymlinks(app, join(root, "resources")), {
      restored: 2,
      collapsed: 0,
    });
    assert.equal(readlinkSync(join(resources, "libllama.dylib")), "libllama.0.dylib");
  });
});
