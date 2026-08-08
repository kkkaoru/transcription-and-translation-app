import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version?: unknown };

const appVersion =
  typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "0.1.1";

const shortGitRevision = (): string => {
  try {
    const revision = execFileSync("git", ["rev-parse", "--short=40", "HEAD"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
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
const createBuildId = (): string => {
  const timestamp = new Date().toISOString().replace(/\D/g, "");
  return `b${timestamp}-${shortGitRevision()}-${randomBytes(4).toString("hex")}`;
};

export default defineConfig(({ command }) => {
  const configuredBuildId = process.env["KOTOBA_BUILD_ID"]?.trim();
  const buildId = configuredBuildId || (command === "build" ? createBuildId() : "dev");

  return {
    define: {
      __KOTOBA_APP_VERSION__: JSON.stringify(appVersion),
      __KOTOBA_BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [react()],
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/.tools/**", "**/node_modules/**", "**/src-tauri/target/**", "**/target/**"],
      },
    },
    build: {
      target: "es2022",
      // Production webview does not need source maps (~2MB). Keep them off so
      // Tauri's frontendDist copy stays small.
      sourcemap: false,
    },
  };
});
