import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface HostTarget {
  readonly bunTarget: string;
  readonly suffix: string;
  readonly executableName: string;
}

const root = process.cwd();
const desktopTauriDir = join(root, "apps", "desktop", "src-tauri");
const binariesDir = join(desktopTauriDir, "binaries");
const parapperDir = join(root, "packages", "parapper-asr");
const parapperTargetDir = join(parapperDir, "target", "release");
const resourcesDir = join(desktopTauriDir, "resources");

const targetForHost = (): HostTarget => {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") {
    return {
      bunTarget: `bun-darwin-${architecture}`,
      suffix: architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
      executableName: "parapper",
    };
  }
  if (process.platform === "win32") {
    return {
      bunTarget: `bun-windows-${architecture}`,
      suffix: `${architecture === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc.exe`,
      executableName: "parapper.exe",
    };
  }
  if (process.platform === "linux") {
    return {
      bunTarget: `bun-linux-${architecture}`,
      suffix: `${architecture === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`,
      executableName: "parapper",
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
  cpSync(source, destination, { recursive: true });
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
  const source = join(parapperTargetDir, target.executableName);
  const destination = join(binariesDir, `kotoba-parapper-${target.suffix}`);
  if (!existsSync(source)) {
    throw new Error(`Parapper binary was not generated: ${source}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }
  copyParapperRuntime();
};

const target = targetForHost();
const gatewayOutput = join(binariesDir, `kotoba-inference-gateway-${target.suffix}`);

mkdirSync(dirname(gatewayOutput), { recursive: true });
run("Kotoba Beacon inference gateway", [
  process.execPath,
  "build",
  "apps/inference-gateway/src/main.ts",
  "--compile",
  `--target=${target.bunTarget}`,
  `--outfile=${gatewayOutput}`,
]);
buildParapperSidecar(target);

process.stdout.write(
  `Bundled sidecars: ${basename(gatewayOutput)} and kotoba-parapper-${target.suffix}\n`,
);
