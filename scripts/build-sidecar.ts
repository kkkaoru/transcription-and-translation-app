import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { cleanBuildArtifacts } from "./clean-build-artifacts.mjs";
import { finalizeMacSidecarBinary } from "./macos-sidecar-binary.mjs";

interface HostTarget {
  readonly bunTarget: string;
  readonly suffix: string;
  readonly executableExtension: string;
}

const root = process.cwd();
const desktopTauriDir = join(root, "apps", "desktop", "src-tauri");
const binariesDir = join(desktopTauriDir, "binaries");
const parapperDir = join(root, "packages", "parapper-asr");
const parapperTargetDir = join(parapperDir, "target", "release");
const resourcesDir = join(desktopTauriDir, "resources");
const llamaDir = join(root, ".tools", "kotoba-llama.cpp");
const llamaBuildDir = join(llamaDir, "build-kotoba");
const llamaSource = "https://github.com/ggml-org/llama.cpp.git";
// Hy-MT2 requires the upstream STQ implementation. Keep the exact revision in
// source so a desktop build remains reproducible as upstream moves forward.
const llamaRevision = "caa596ab3f0f8768ee326d6e3d5d39782194676c";
const zenzDir = join(root, ".tools", "kotoba-zenz-llama.cpp");
const zenzBuildDir = join(zenzDir, "build-kotoba");
const zenzSource = "https://github.com/azooKey/llama.cpp.git";
// This fork contains zenz's gpt2-small-japanese-char tokenizer support.
const zenzRevision = "88b97a47dc7f5892e2d5a6856fbe9cfe237f9e5c";

const targetForHost = (): HostTarget => {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") {
    return {
      bunTarget: `bun-darwin-${architecture}`,
      suffix: architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
      executableExtension: "",
    };
  }
  if (process.platform === "win32") {
    return {
      bunTarget: `bun-windows-${architecture}`,
      suffix: `${architecture === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc.exe`,
      executableExtension: ".exe",
    };
  }
  if (process.platform === "linux") {
    return {
      bunTarget: `bun-linux-${architecture}`,
      suffix: `${architecture === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`,
      executableExtension: "",
    };
  }
  throw new Error(`Unsupported sidecar host platform: ${process.platform}/${process.arch}`);
};

const cleanRustupEnvironment = (): Record<string, string | undefined> => {
  const environment = { ...process.env };
  delete environment.RUSTUP_TOOLCHAIN;
  return environment;
};

const run = (
  label: string,
  cmd: string[],
  cwd = root,
  env: Record<string, string | undefined> = process.env,
): void => {
  const result = Bun.spawnSync({ cmd, cwd, env, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode ?? "unknown"}`);
  }
};

const copyDirectory = (source: string, destination: string): void => {
  if (!existsSync(source)) {
    throw new Error(`Expected runtime directory was not generated: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      if (path === source) return true;
      const name = basename(path);
      return name !== ".gitkeep" && name !== ".gitignore";
    },
  });
};

const copyParapperRuntime = (): void => {
  if (process.platform === "darwin") {
    copyDirectory(
      join(parapperDir, "src-tauri", "macos-runtime"),
      join(resourcesDir, "macos-runtime"),
    );
    return;
  }
  if (process.platform === "win32") {
    const destination = join(resourcesDir, "parapper-runtime");
    mkdirSync(destination, { recursive: true });
    const dlls = readdirSync(parapperTargetDir).filter((file) =>
      file.toLowerCase().endsWith(".dll"),
    );
    if (dlls.length === 0) {
      throw new Error(`Parapper did not produce runtime DLLs in ${parapperTargetDir}`);
    }
    for (const dll of dlls) {
      copyFileSync(join(parapperTargetDir, dll), join(destination, dll));
    }
  }
};

const llamaServerName = (target: HostTarget): string => `llama-server${target.executableExtension}`;

const llamaBuildBin = (target: HostTarget): string => {
  const serverName = llamaServerName(target);
  const candidates = [join(llamaBuildDir, "bin"), join(llamaBuildDir, "bin", "Release")];
  const directory = candidates.find((candidate) => existsSync(join(candidate, serverName)));
  if (!directory) {
    throw new Error(`llama.cpp did not produce ${serverName} in ${llamaBuildDir}`);
  }
  return directory;
};

const ensureLlamaSource = (): void => {
  if (!existsSync(join(llamaDir, ".git"))) {
    mkdirSync(dirname(llamaDir), { recursive: true });
    run("initialize llama.cpp source directory", ["git", "init", llamaDir]);
  }
  run("fetch pinned llama.cpp source", [
    "git",
    "-C",
    llamaDir,
    "fetch",
    "--depth",
    "1",
    llamaSource,
    llamaRevision,
  ]);
  run("checkout pinned llama.cpp source", [
    "git",
    "-C",
    llamaDir,
    "checkout",
    "--detach",
    "FETCH_HEAD",
  ]);
};

const copyLlamaRuntime = (sourceDirectory: string): void => {
  copyRuntimeLibraries(sourceDirectory, join(resourcesDir, "llama-runtime"));
};

const copyRuntimeLibraries = (sourceDirectory: string, destination: string): void => {
  const extension =
    process.platform === "darwin" ? ".dylib" : process.platform === "win32" ? ".dll" : ".so";
  mkdirSync(destination, { recursive: true });
  const libraries = readdirSync(sourceDirectory).filter((file) => file.includes(extension));
  if (libraries.length === 0) {
    throw new Error(`llama.cpp did not produce runtime libraries in ${sourceDirectory}`);
  }
  // Copy real files first, then recreate symlinks. CMake emits
  // libfoo.dylib -> libfoo.0.dylib -> libfoo.0.0.1.dylib; flattening those
  // into three full copies inflates the app bundle by tens of megabytes.
  const files = libraries.filter((file) => !lstatSync(join(sourceDirectory, file)).isSymbolicLink());
  const links = libraries.filter((file) => lstatSync(join(sourceDirectory, file)).isSymbolicLink());
  for (const library of files) {
    copyFileSync(join(sourceDirectory, library), join(destination, library));
  }
  for (const library of links) {
    const target = join(destination, library);
    try {
      unlinkSync(target);
    } catch {
      // Destination may not exist yet.
    }
    symlinkSync(readlinkSync(join(sourceDirectory, library)), target);
  }
};

const finalizeMacSidecar = (output: string, runtimeDirectory = ""): void => {
  if (process.platform !== "darwin") {
    return;
  }
  finalizeMacSidecarBinary(output, runtimeDirectory);
};

const buildLlamaSidecar = (target: HostTarget): void => {
  ensureLlamaSource();
  const cmakeArgs = [
    "cmake",
    "-S",
    llamaDir,
    "-B",
    llamaBuildDir,
    "-DLLAMA_BUILD_UI=OFF",
    // Model files are provisioned by Tauri with pinned URLs, so the server
    // does not need its HTTPS client. This also avoids a Homebrew OpenSSL
    // dylib becoming an undeclared dependency of the distributed sidecar.
    "-DLLAMA_OPENSSL=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DGGML_METAL=${process.platform === "darwin" ? "ON" : "OFF"}`,
  ];
  run("configure pinned llama.cpp", cmakeArgs);
  run("build bundled llama.cpp server", [
    "cmake",
    "--build",
    llamaBuildDir,
    "--target",
    "llama-server",
    "--config",
    "Release",
    "--parallel",
    "4",
  ]);

  const sourceDirectory = llamaBuildBin(target);
  const source = join(sourceDirectory, llamaServerName(target));
  const destination = join(binariesDir, `kotoba-llama-server-${target.suffix}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }
  finalizeMacSidecar(destination, "llama-runtime");
  copyLlamaRuntime(sourceDirectory);
};

const zenzBuildBin = (target: HostTarget): string => {
  const serverName = llamaServerName(target);
  const candidates = [join(zenzBuildDir, "bin"), join(zenzBuildDir, "bin", "Release")];
  const directory = candidates.find((candidate) => existsSync(join(candidate, serverName)));
  if (!directory) {
    throw new Error(`AzooKey llama.cpp did not produce ${serverName} in ${zenzBuildDir}`);
  }
  return directory;
};

const ensureZenzSource = (): void => {
  if (!existsSync(join(zenzDir, ".git"))) {
    mkdirSync(dirname(zenzDir), { recursive: true });
    run("initialize AzooKey llama.cpp source directory", ["git", "init", zenzDir]);
  }
  run("fetch pinned AzooKey llama.cpp source", [
    "git",
    "-C",
    zenzDir,
    "fetch",
    "--depth",
    "1",
    zenzSource,
    zenzRevision,
  ]);
  run("checkout pinned AzooKey llama.cpp source", [
    "git",
    "-C",
    zenzDir,
    "checkout",
    "--detach",
    "FETCH_HEAD",
  ]);
};

const buildZenzSidecar = (target: HostTarget): void => {
  ensureZenzSource();
  run("configure pinned AzooKey llama.cpp", [
    "cmake",
    "-S",
    zenzDir,
    "-B",
    zenzBuildDir,
    "-DLLAMA_CURL=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
    `-DGGML_METAL=${process.platform === "darwin" ? "ON" : "OFF"}`,
  ]);
  run("build bundled zenz server", [
    "cmake",
    "--build",
    zenzBuildDir,
    "--target",
    "llama-server",
    "--config",
    "Release",
    "--parallel",
    "4",
  ]);

  const sourceDirectory = zenzBuildBin(target);
  const source = join(sourceDirectory, llamaServerName(target));
  const destination = join(binariesDir, `kotoba-zenz-server-${target.suffix}`);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }
  finalizeMacSidecar(destination, "zenz-runtime");
  copyRuntimeLibraries(sourceDirectory, join(resourcesDir, "zenz-runtime"));
};

const buildParapperSidecar = (target: HostTarget): void => {
  const rustupEnvironment = cleanRustupEnvironment();
  // Tauri's resource map is shared by every target. Keep both directories
  // present even when this host only needs one of them.
  mkdirSync(join(resourcesDir, "macos-runtime"), { recursive: true });
  mkdirSync(join(resourcesDir, "parapper-runtime"), { recursive: true });
  // The normal Parapper build intentionally creates its dependency-license JSON first.
  // Keep that contract for the embedded binary as it is distributed with the product.
  run(
    "cargo-about availability check",
    ["cargo", "about", "--version"],
    parapperDir,
    rustupEnvironment,
  );
  run(
    "Parapper frontend and license generation",
    [process.execPath, "run", "build"],
    parapperDir,
    rustupEnvironment,
  );
  run(
    "Parapper headless binary",
    ["cargo", "build", "--manifest-path", "Cargo.toml", "--release", "--package", "parapper"],
    parapperDir,
    rustupEnvironment,
  );
  const source = join(parapperTargetDir, `parapper${target.executableExtension}`);
  const destination = join(binariesDir, `kotoba-parapper-${target.suffix}`);
  if (!existsSync(source)) {
    throw new Error(`Parapper binary was not generated: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }
  finalizeMacSidecar(destination, "macos-runtime");
  copyParapperRuntime();
};

const target = targetForHost();
const gatewayOutput = join(binariesDir, `kotoba-inference-gateway-${target.suffix}`);

// Keep each sidecar/Tauri build bounded to the current generated outputs. The
// cleanup intentionally preserves Rust/CMake incremental caches and only
// removes exact frontend/bundle outputs plus Bun compile leftovers.
await cleanBuildArtifacts();
mkdirSync(dirname(gatewayOutput), { recursive: true });
run("Kotoba Beacon inference gateway", [
  process.execPath,
  "build",
  "apps/inference-gateway/src/main.ts",
  "--compile",
  "--minify",
  `--target=${target.bunTarget}`,
  `--outfile=${gatewayOutput}`,
]);
finalizeMacSidecar(gatewayOutput);
buildParapperSidecar(target);
buildZenzSidecar(target);
buildLlamaSidecar(target);
// `bun build --compile` leaves a temporary `.bun-build` Mach-O next to the
// output even after the compiled binary has been copied. Remove only that
// temporary file after a successful sidecar build; fresh `dist` output is
// retained for the subsequent Tauri step.
await cleanBuildArtifacts({ temporaryOnly: true });

process.stdout.write(
  `Bundled sidecars: ${basename(gatewayOutput)}, kotoba-parapper-${target.suffix}, kotoba-zenz-server-${target.suffix}, and kotoba-llama-server-${target.suffix}\n`,
);
