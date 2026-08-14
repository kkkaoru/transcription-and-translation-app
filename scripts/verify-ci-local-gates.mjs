#!/usr/bin/env node

/**
 * Guard the one-way quality promise: a green local `check:all` must include
 * every repository quality gate that CI runs. Local-only checks are allowed.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const normalizeCiCommand = (command) => command.trim().replace(/^env -u RUSTUP_TOOLCHAIN\s+/u, "");

const matrixCommand = `\${{ matrix.command }}`;

/** CI commands whose local equivalent is a named package.json script. */
export const ciGateMappings = new Map([
  [
    "cargo build --locked --manifest-path packages/azookey-wasm/Cargo.toml --target wasm32-unknown-unknown --release",
    "rust:wasm:build",
  ],
  [
    "cargo build --locked --manifest-path packages/vibrato/wasm/Cargo.toml --target wasm32-unknown-unknown --release",
    "rust:vibrato:wasm:build",
  ],
  [
    "cargo test --locked --manifest-path packages/parapper-asr/Cargo.toml -p parapper",
    "parapper:rust:test",
  ],
]);

/**
 * CI gates which cannot or should not be reproduced by a cross-platform local
 * source gate. Every exclusion is exact and has a required explanation.
 */
export const ciGateExclusions = new Map([
  [
    matrixCommand,
    "The desktop release build runs separately on macOS arm64/x64 and Windows runners.",
  ],
  [
    "bun run check:macos-signing",
    "This reports macOS signing credentials only on macOS release runners.",
  ],
  [
    "bun run check:macos-autoswitch",
    "This launches the built macOS app and is unavailable on other local platforms.",
  ],
]);

const isGateCommand = (command) =>
  command === matrixCommand ||
  /^bun run \S+$/u.test(command) ||
  /^cargo (?:build|test|clippy|fmt)\b/u.test(command);

export const extractCiGateCommands = (workflow) => {
  const commands = new Set();
  for (const line of workflow.split("\n")) {
    const match = line.match(/^\s*(?:-\s*)?run:\s+([^|].*?)\s*$/u);
    if (!match) continue;
    const command = normalizeCiCommand(match[1]);
    if (isGateCommand(command)) commands.add(command);
  }
  return commands;
};

export const extractLocalGateScripts = (packageJson) => {
  const command = packageJson.scripts?.["check:all:unlocked"];
  if (typeof command !== "string") {
    throw new Error("package.json must define scripts.check:all:unlocked");
  }

  const scripts = new Set();
  for (const step of command.split(" && ")) {
    const match = step.match(/^bun run (\S+)$/u);
    if (!match) throw new Error(`unsupported local quality-gate step: ${step}`);
    scripts.add(match[1]);
  }
  return scripts;
};

const localScriptForCiCommand = (command) => {
  const bunScript = command.match(/^bun run (\S+)$/u)?.[1];
  return bunScript ?? ciGateMappings.get(command) ?? null;
};

export const verifyCiLocalGateParity = ({ workflow, packageJson }) => {
  const ciCommands = extractCiGateCommands(workflow);
  const localScripts = extractLocalGateScripts(packageJson);
  const missingLocalScripts = [];
  const unknownCiCommands = [];

  for (const command of ciCommands) {
    if (ciGateExclusions.has(command)) continue;
    const localScript = localScriptForCiCommand(command);
    if (!localScript) {
      unknownCiCommands.push(command);
    } else if (!localScripts.has(localScript)) {
      missingLocalScripts.push(`${localScript} (CI: ${command})`);
    }
  }

  const staleExclusions = [];
  for (const [command, reason] of ciGateExclusions) {
    if (!reason.trim()) throw new Error(`CI gate exclusion has no reason: ${command}`);
    if (!ciCommands.has(command)) staleExclusions.push(command);
  }

  return { missingLocalScripts, unknownCiCommands, staleExclusions };
};

export const main = () => {
  const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const result = verifyCiLocalGateParity({ workflow, packageJson });
  const failures = [
    ...result.missingLocalScripts.map((value) => `CI gate missing from check:all: ${value}`),
    ...result.unknownCiCommands.map((value) => `unclassified CI gate: ${value}`),
    ...result.staleExclusions.map((value) => `stale CI gate exclusion: ${value}`),
  ];
  if (failures.length === 0) {
    console.log("CI gate parity: local check:all includes every classified CI gate");
    return 0;
  }
  for (const failure of failures) console.error(`CI gate parity: ${failure}`);
  return 1;
};

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMainModule) process.exitCode = main();
