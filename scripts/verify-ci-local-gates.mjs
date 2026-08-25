#!/usr/bin/env node

/**
 * Guard the one-way quality promise: a green local `check:all` must include
 * every repository quality gate that CI runs. Local-only checks are allowed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_GATE_STEPS } from "./quality-gate-steps.mjs";

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
  ["cargo fmt --manifest-path apps/native/Cargo.toml --all -- --check", "rust:native:fmt"],
  [
    "cargo clippy --locked --manifest-path apps/native/Cargo.toml --all-targets -- -D warnings",
    "rust:native:lint",
  ],
  ["cargo test --locked --manifest-path apps/native/Cargo.toml", "rust:native:test"],
  [
    "cargo test --locked --manifest-path apps/native/Cargo.toml --no-default-features --lib -- --test-threads=1",
    "rust:native:test",
  ],
  ["cargo build --locked --release --manifest-path apps/native/Cargo.toml", "rust:native:build"],
]);

/**
 * CI gates which cannot or should not be reproduced by a cross-platform local
 * source gate. Every exclusion is exact and has a required explanation.
 */
export const buildCleanupTestExclusions = new Map();

/**
 * Coverage gates deliberately absent from CI. Every entry needs a reason; the
 * map starts empty because the four packages that were missing had simply
 * never been added when their scripts appeared.
 */
export const ciCoverageExclusions = new Map();

/**
 * Typecheck gates deliberately absent from CI. Empty for the same reason as
 * coverage: every `*:typecheck` script is a gate, and none is local-only.
 */
export const ciTypecheckExclusions = new Map();

/**
 * Lint gates deliberately absent from CI. Empty after rust:zenz-verifier:lint
 * joined CI; that leftover was drift, not a local-only crate.
 */
export const ciLintExclusions = new Map([
  ["rust:native:lint", "Native matrix invokes the equivalent Cargo command without Bun"],
]);

/**
 * Fmt gates deliberately absent from CI. Empty after rust:zenz-verifier:fmt
 * joined CI. `format` and `format:check` are a different suffix on purpose.
 */
export const ciFmtExclusions = new Map([
  ["rust:native:fmt", "Native matrix invokes the equivalent Cargo command without Bun"],
]);

const matchesGateSuffix = (name, suffix) => name === suffix || name.endsWith(`:${suffix}`);

const scriptsEndingWith = (packageJson, suffix) =>
  Object.keys(packageJson.scripts).filter((name) => matchesGateSuffix(name, suffix));

const ciScriptsEndingWith = (workflow, suffix) =>
  extractCiGateCommands(workflow)
    .map((command) => command.replace(/^bun run\s+/u, ""))
    .filter((script) => matchesGateSuffix(script, suffix));

const assertNamedGateParity = ({ packageJson, workflow, suffix, label, exclusions }) => {
  const local = scriptsEndingWith(packageJson, suffix);
  const ci = new Set(ciScriptsEndingWith(workflow, suffix));
  const missingFromCi = local.filter((script) => !ci.has(script) && !exclusions.has(script));
  const missingLocally = [...ci].filter((script) => !local.includes(script));
  if (missingFromCi.length > 0 || missingLocally.length > 0) {
    const parts = [];
    if (missingFromCi.length > 0) {
      parts.push(`${label} gates missing from CI: ${missingFromCi.join(", ")}`);
    }
    if (missingLocally.length > 0) {
      parts.push(`CI ${label} gates with no local script: ${missingLocally.join(", ")}`);
    }
    throw new Error(parts.join("; "));
  }
};

/**
 * Compares the coverage scripts declared in package.json against the ones CI
 * runs. package.json is the source rather than QUALITY_GATE_STEPS on purpose:
 * a script missing from both gates is invisible to the local list, which is
 * how dictionaries:test:coverage went unrun by either. Together with the
 * existing CI-subset check this pins
 * `package.json coverage ⊆ CI ⊆ check:all`.
 */
export const assertCoverageGateParity = ({ packageJson, workflow }) =>
  assertNamedGateParity({
    packageJson,
    workflow,
    suffix: "test:coverage",
    label: "coverage",
    exclusions: ciCoverageExclusions,
  });

/**
 * Same chain as coverage, for the typecheck suffix only.
 */
export const assertTypecheckGateParity = ({ packageJson, workflow }) =>
  assertNamedGateParity({
    packageJson,
    workflow,
    suffix: "typecheck",
    label: "typecheck",
    exclusions: ciTypecheckExclusions,
  });

/** Same chain for `lint` / `*:lint`. Test stays out: that suffix is mixed. */
export const assertLintGateParity = ({ packageJson, workflow }) =>
  assertNamedGateParity({
    packageJson,
    workflow,
    suffix: "lint",
    label: "lint",
    exclusions: ciLintExclusions,
  });

/** Same chain for `*:fmt`. Does not include `format:check`. */
export const assertFmtGateParity = ({ packageJson, workflow }) =>
  assertNamedGateParity({
    packageJson,
    workflow,
    suffix: "fmt",
    label: "fmt",
    exclusions: ciFmtExclusions,
  });

export const ciGateExclusions = new Map();

const buildCleanupTestsFromCommand = (command) =>
  new Set(command.split(/\s+/u).filter((value) => /^scripts\/[^/]+\.test\.mjs$/u.test(value)));

export const assertBuildCleanupTestManifest = ({
  command,
  scriptsDirectory,
  discoveredTests = readdirSync(scriptsDirectory, { recursive: true })
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `scripts/${name.replaceAll("\\", "/")}`),
  exclusions = buildCleanupTestExclusions,
}) => {
  for (const [path, reason] of exclusions) {
    if (!reason.trim()) throw new Error(`scripts test exclusion has no reason: ${path}`);
  }
  const discovered = new Set(discoveredTests.filter((path) => !exclusions.has(path)));
  const listed = buildCleanupTestsFromCommand(command);
  const unlisted = [...discovered].filter((path) => !listed.has(path)).sort();
  const missing = [...listed].filter((path) => !discovered.has(path)).sort();
  const failures = [];
  if (unlisted.length > 0) failures.push(`unlisted scripts tests: ${unlisted.join(", ")}`);
  if (missing.length > 0) {
    failures.push(`listed scripts tests missing from disk: ${missing.join(", ")}`);
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
};

const isGateCommand = (command) =>
  command === matrixCommand ||
  /^bun run \S+$/u.test(command) ||
  /^cargo (?:build|test|clippy|fmt)\b/u.test(command);

export const extractQualityJob = (workflow) => {
  const match = workflow.match(/\n {2}quality:\n([\s\S]*?)(?=\n {2}[A-Za-z0-9_-]+:|\n?$)/u);
  return match?.[1] ?? "";
};

const extractGateCommandsFromText = (text) => {
  const commands = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:-\s*)?run:\s+([^|].*?)\s*$/u);
    if (!match) continue;
    const command = normalizeCiCommand(match[1]);
    if (isGateCommand(command)) commands.push(command);
  }
  return commands;
};

export const extractCiGateCommands = (workflow) => extractGateCommandsFromText(workflow);

export const extractQualityGateCommands = (workflow) =>
  extractGateCommandsFromText(extractQualityJob(workflow));

export const extractLocalGateScripts = (packageJson) => {
  const command = packageJson.scripts?.["check:all:unlocked"];
  if (command !== "node scripts/run-timed-quality-steps.mjs") {
    throw new Error("package.json check:all:unlocked must run the timed quality-step runner");
  }
  return [...QUALITY_GATE_STEPS];
};

const countOccurrences = (values) => {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
};

const localScriptForCiCommand = (command) => {
  const bunScript = command.match(/^bun run (\S+)$/u)?.[1];
  return bunScript ?? ciGateMappings.get(command) ?? null;
};

export const verifyCiLocalGateParity = ({ workflow, packageJson }) => {
  const ciCommands = extractCiGateCommands(workflow);
  const qualityCommands = extractQualityGateCommands(workflow);
  const localScripts = extractLocalGateScripts(packageJson);
  const localCounts = countOccurrences(localScripts);
  const requiredCounts = new Map();
  const missingLocalScripts = [];
  const unknownCiCommands = [];

  for (const command of qualityCommands) {
    if (ciGateExclusions.has(command)) continue;
    const localScript = localScriptForCiCommand(command);
    if (!localScript) {
      unknownCiCommands.push(command);
      continue;
    }
    requiredCounts.set(localScript, (requiredCounts.get(localScript) ?? 0) + 1);
  }
  for (const command of ciCommands) {
    if (ciGateExclusions.has(command) || qualityCommands.includes(command)) continue;
    const localScript = localScriptForCiCommand(command);
    if (!localScript) {
      unknownCiCommands.push(command);
    } else if (!localCounts.has(localScript)) {
      requiredCounts.set(localScript, Math.max(requiredCounts.get(localScript) ?? 0, 1));
    }
  }
  for (const [script, required] of requiredCounts) {
    const actual = localCounts.get(script) ?? 0;
    if (actual < required) {
      missingLocalScripts.push(
        actual === 0
          ? `${script} (CI: bun run ${script})`
          : `${script} x${required} (local has ${actual})`,
      );
    }
  }

  const staleExclusions = [];
  for (const [command, reason] of ciGateExclusions) {
    if (!reason.trim()) throw new Error(`CI gate exclusion has no reason: ${command}`);
    if (!ciCommands.includes(command)) staleExclusions.push(command);
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
