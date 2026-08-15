#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(desktopRoot, "../..");
export const RUST_BUILD_IDENTITY_PATH = join(desktopRoot, "src-tauri/generated/build-identity.txt");

export const readPackageVersion = () => {
  const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  return typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "0.1.1";
};

export const shortGitRevision = () => {
  try {
    const revision = execFileSync("git", ["rev-parse", "--short=40", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase();
    return /^[0-9a-f]{7,40}$/.test(revision) ? revision : "nogit";
  } catch {
    return "nogit";
  }
};

/** Generate a human-readable ID that remains unique for repeated builds. */
export const createBuildId = () => {
  const timestamp = new Date().toISOString().replace(/\D/g, "");
  return `b${timestamp}-${shortGitRevision()}-${randomBytes(4).toString("hex")}`;
};

export const resolveBuildIdentity = (command, env = process.env) => {
  const configuredBuildId = env["KOTOBA_BUILD_ID"]?.trim();
  return {
    appVersion: readPackageVersion(),
    buildId: configuredBuildId || (command === "build" ? createBuildId() : "dev"),
  };
};

export const writeRustBuildIdentity = ({ appVersion, buildId }) => {
  mkdirSync(dirname(RUST_BUILD_IDENTITY_PATH), { recursive: true });
  writeFileSync(RUST_BUILD_IDENTITY_PATH, `${appVersion}\n${buildId}\n`);
};
