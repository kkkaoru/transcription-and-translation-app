import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  assemblePortableNativeRelease,
  nativeExecutableName,
  runtimeLibraryNames,
} from "./package-native-release.mjs";

const temporaryDirectories = [];

const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "kotoba-native-package-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Native release packaging", () => {
  it("uses the platform executable name", () => {
    assert.equal(nativeExecutableName("win32"), "kotoba-beacon-native.exe");
    assert.equal(nativeExecutableName("linux"), "kotoba-beacon-native");
    assert.equal(nativeExecutableName("darwin"), "kotoba-beacon-native");
  });

  it("selects only required runtime library families", () => {
    assert.deepEqual(
      runtimeLibraryNames("win32", [
        "kotoba-beacon-native.exe",
        "onnxruntime.dll",
        "sherpa-onnx-c-api.dll",
        "unrelated.dll",
      ]),
      ["onnxruntime.dll", "sherpa-onnx-c-api.dll"],
    );
    assert.deepEqual(
      runtimeLibraryNames("linux", [
        "libonnxruntime.so.1",
        "libsherpa-onnx-c-api.so",
        "libunrelated.so",
      ]),
      ["libonnxruntime.so.1", "libsherpa-onnx-c-api.so"],
    );
  });

  it("assembles a runnable Linux directory without launching it", () => {
    const root = temporaryDirectory();
    const source = join(root, "release");
    const output = join(root, "package");
    mkdirSync(source);
    writeFileSync(join(source, "kotoba-beacon-native"), "binary");
    writeFileSync(join(source, "libonnxruntime.so.1"), "onnx");
    writeFileSync(join(source, "libsherpa-onnx-c-api.so"), "sherpa");

    const result = assemblePortableNativeRelease({
      sourceBinary: join(source, "kotoba-beacon-native"),
      outputDir: output,
      targetPlatform: "linux",
    });

    assert.deepEqual(readdirSync(output).sort(), [
      "azookey",
      "kotoba-beacon-native",
      "libonnxruntime.so.1",
      "libsherpa-onnx-c-api.so",
      "third-party",
    ]);
    assert.deepEqual(result.libraries, ["libonnxruntime.so.1", "libsherpa-onnx-c-api.so"]);
    assert.deepEqual(readdirSync(join(output, "azookey")), ["system.azkdict.gz"]);
    assert.deepEqual(readdirSync(join(output, "third-party")).sort(), [
      "NOTICE",
      "gpui-LICENSE-APACHE",
      "gpui-component-LICENSE-APACHE",
    ]);
  });

  it("rejects incomplete runtime output", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "kotoba-beacon-native.exe"), "binary");
    writeFileSync(join(root, "onnxruntime.dll"), "onnx");

    assert.throws(
      () =>
        assemblePortableNativeRelease({
          sourceBinary: join(root, "kotoba-beacon-native.exe"),
          outputDir: join(root, "package"),
          targetPlatform: "win32",
        }),
      /missing in-process ONNX Runtime or sherpa-onnx libraries/u,
    );
  });
});
