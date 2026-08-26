#!/usr/bin/env node

/**
 * Assemble a runnable Native release directory for the current desktop OS.
 * This packages build outputs only; it never starts or foregrounds the app.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AZOOKEY_DICTIONARY_SOURCE,
  assembleNativeApp,
  BINARY_NAME,
  PRODUCT_NAME,
} from "./install-macos-native-app.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const nativeExecutableName = (targetPlatform) =>
  targetPlatform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;

export const runtimeLibraryNames = (targetPlatform, files) => {
  if (targetPlatform === "win32") {
    return files.filter((name) => /^(?:onnxruntime|sherpa-onnx).*\.dll$/iu.test(name)).sort();
  }
  if (targetPlatform === "linux") {
    return files
      .filter((name) => /^lib(?:onnxruntime|sherpa-onnx).*\.so(?:\..*)?$/u.test(name))
      .sort();
  }
  return [];
};

const assertRuntimeFamilies = (targetPlatform, names) => {
  const onnx = names.some((name) => name.toLowerCase().includes("onnxruntime"));
  const sherpa = names.some((name) => name.toLowerCase().includes("sherpa-onnx"));
  if (!onnx || !sherpa) {
    throw new Error(
      `${targetPlatform} release is missing in-process ONNX Runtime or sherpa-onnx libraries`,
    );
  }
};

export const assemblePortableNativeRelease = ({ sourceBinary, outputDir, targetPlatform }) => {
  if (!existsSync(sourceBinary)) {
    throw new Error(`native release executable was not found: ${sourceBinary}`);
  }
  if (!outputDir) {
    throw new Error("native release output directory is required");
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(sourceBinary, join(outputDir, basename(sourceBinary)));
  if (!existsSync(AZOOKEY_DICTIONARY_SOURCE)) {
    throw new Error(`missing bundled AzooKey dictionary ${AZOOKEY_DICTIONARY_SOURCE}`);
  }
  const azookeyDir = join(outputDir, "azookey");
  mkdirSync(azookeyDir, { recursive: true });
  cpSync(AZOOKEY_DICTIONARY_SOURCE, join(azookeyDir, "system.azkdict.gz"));

  const sourceDir = dirname(sourceBinary);
  const libraries = runtimeLibraryNames(targetPlatform, readdirSync(sourceDir));
  assertRuntimeFamilies(targetPlatform, libraries);
  for (const library of libraries) {
    cpSync(join(sourceDir, library), join(outputDir, library), { dereference: true });
  }
  return { outputDir, libraries };
};

const readOption = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

export const packageNativeRelease = ({
  targetPlatform = platform(),
  targetArch = arch(),
  sourceBinary,
  outputPath,
} = {}) => {
  const executable =
    sourceBinary ??
    join(repoRoot, "apps", "native", "target", "release", nativeExecutableName(targetPlatform));
  const defaultName = `kotoba-beacon-native-${targetPlatform}-${targetArch}`;
  const output = outputPath ?? join(repoRoot, "dist", defaultName);

  if (targetPlatform === "darwin") {
    const appPath = extname(output) === ".app" ? output : join(output, `${PRODUCT_NAME}.app`);
    return assembleNativeApp({ sourceBinary: executable, installApp: appPath });
  }
  if (targetPlatform !== "win32" && targetPlatform !== "linux") {
    throw new Error(`unsupported Native packaging platform: ${targetPlatform}`);
  }
  return assemblePortableNativeRelease({
    sourceBinary: executable,
    outputDir: output,
    targetPlatform,
  });
};

const main = () => {
  try {
    const args = process.argv.slice(2);
    const result = packageNativeRelease({
      targetPlatform: readOption(args, "--platform") ?? platform(),
      targetArch: readOption(args, "--arch") ?? arch(),
      sourceBinary: readOption(args, "--source"),
      outputPath: readOption(args, "--output"),
    });
    console.log(`Packaged ${result.outputDir ?? result.installApp}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
