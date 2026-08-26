#!/usr/bin/env node

/**
 * Enforce line coverage for the hand-written mobile pipeline boundaries.
 * Run with Node after `flutter test --coverage`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultCoveragePath = resolve(repositoryRoot, "apps/mobile/coverage/lcov.info");

export const MOBILE_COVERAGE_THRESHOLDS = new Map([
  ["lib/main.dart", 95],
  ["lib/src/companion_connection.dart", 95],
  ["lib/src/companion_controller.dart", 95],
  ["lib/src/native_processing.dart", 95],
]);

export const parseLcovLineCoverage = (content) => {
  const coverage = new Map();
  let source = null;
  let found = 0;
  let hit = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("SF:")) source = line.slice(3).replaceAll("\\", "/");
    if (line.startsWith("LF:")) found = Number.parseInt(line.slice(3), 10);
    if (line.startsWith("LH:")) hit = Number.parseInt(line.slice(3), 10);
    if (line !== "end_of_record" || source === null) continue;
    coverage.set(source, { found, hit });
    source = null;
    found = 0;
    hit = 0;
  }
  return coverage;
};

export const verifyMobileCoverage = ({ content, thresholds = MOBILE_COVERAGE_THRESHOLDS }) => {
  const coverage = parseLcovLineCoverage(content);
  const results = [];
  for (const [path, minimum] of thresholds) {
    const entry = [...coverage].find(([source]) => source.endsWith(path))?.[1];
    if (!entry || entry.found <= 0) throw new Error(`mobile coverage is missing ${path}`);
    const percentage = (entry.hit / entry.found) * 100;
    if (percentage < minimum) {
      throw new Error(
        `${path} line coverage ${percentage.toFixed(1)}% is below ${minimum.toFixed(1)}%`,
      );
    }
    results.push({ path, found: entry.found, hit: entry.hit, percentage });
  }
  return results;
};

const main = () => {
  const coveragePath = process.argv[2] ? resolve(process.argv[2]) : defaultCoveragePath;
  const results = verifyMobileCoverage({ content: readFileSync(coveragePath, "utf8") });
  for (const result of results) {
    console.log(`${result.path}: ${result.hit}/${result.found} (${result.percentage.toFixed(1)}%)`);
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
