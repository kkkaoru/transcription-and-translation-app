import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const targetForHost = (): { bunTarget: string; suffix: string } => {
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") {
    return {
      bunTarget: `bun-darwin-${architecture}`,
      suffix: architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
    };
  }
  if (process.platform === "win32") {
    return {
      bunTarget: `bun-windows-${architecture}`,
      suffix: `${architecture === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc.exe`,
    };
  }
  if (process.platform === "linux") {
    return {
      bunTarget: `bun-linux-${architecture}`,
      suffix: `${architecture === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`,
    };
  }
  throw new Error(`Unsupported sidecar host platform: ${process.platform}/${process.arch}`);
};

const { bunTarget, suffix } = targetForHost();
const output = join(
  process.cwd(),
  "apps",
  "desktop",
  "src-tauri",
  "binaries",
  `kotoba-inference-gateway-${suffix}`,
);

mkdirSync(dirname(output), { recursive: true });
const build = Bun.spawnSync({
  cmd: [
    process.execPath,
    "build",
    "apps/inference-gateway/src/main.ts",
    "--compile",
    `--target=${bunTarget}`,
    `--outfile=${output}`,
  ],
  cwd: process.cwd(),
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  process.exit(build.exitCode);
}
