#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LONG_GAP_MILLIS = 2_000;
const DEFAULT_FIRST_CAPTION_MILLIS = 1_500;

const normalizeCaption = (value) =>
  typeof value === "string" ? value.trim().replace(/(?:\.{3}|[。！？]+)$/u, "") : "";

const sessionKey = (record) =>
  `${record.process_id ?? "unknown"}:${record.session_started_unix_ms ?? "unknown"}`;

const turnKey = (record) => `${sessionKey(record)}:${record.payload?.turn_id ?? "unknown"}`;

const logicalTurnKey = (record) => {
  const turnSessionId = record.payload?.turn_session_id;
  const logicalTurnId = record.payload?.logical_turn_id;
  if (Number.isInteger(turnSessionId) && Number.isInteger(logicalTurnId)) {
    return `${sessionKey(record)}:${turnSessionId}:${logicalTurnId}`;
  }
  const match = /^turn-(\d+)-(\d+)-/u.exec(record.payload?.turn_id ?? "");
  return match ? `${sessionKey(record)}:${match[1]}:${match[2]}` : null;
};

/**
 * Classifies opt-in Native pipeline diagnostics without retaining or loading PCM audio.
 */
export function analyzePipelineRecords(
  records,
  {
    longGapMillis = DEFAULT_LONG_GAP_MILLIS,
    firstCaptionMillis = DEFAULT_FIRST_CAPTION_MILLIS,
  } = {},
) {
  const issues = [];
  const captionsByTurn = new Map();
  const displayedPartialTurns = new Set();
  const routedRevisions = new Map();
  const appliedRevisions = new Set();

  for (const record of records) {
    const stage = record.stage;
    if (stage === "asr_engine_caption") {
      const key = turnKey(record);
      const captions = captionsByTurn.get(key) ?? [];
      captions.push(record);
      captionsByTurn.set(key, captions);
    } else if (stage === "asr_partial_window" && record.payload?.displayed) {
      const key = logicalTurnKey(record);
      if (key) displayedPartialTurns.add(key);
    } else if (stage === "asr_routed" || stage === "partial_window_routed") {
      const key = `${sessionKey(record)}:${record.payload?.revision}`;
      routedRevisions.set(key, record);
    } else if (stage === "ui_caption_applied") {
      appliedRevisions.add(`${sessionKey(record)}:${record.payload?.revision}`);
    } else if (stage === "ui_caption_discarded") {
      issues.push({
        kind: "ui_discarded_caption",
        session: sessionKey(record),
        sequence: record.sequence,
        reason: record.payload?.reason ?? "unknown",
      });
    }
  }

  for (const [key, captions] of captionsByTurn) {
    captions.sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
    const first = captions[0];
    const firstCaptionLatency = first?.payload?.speech_to_first_partial_millis;
    const firstCaptionAlreadyPreviewed = displayedPartialTurns.has(logicalTurnKey(first));
    if (
      Number.isFinite(firstCaptionLatency) &&
      firstCaptionLatency > firstCaptionMillis &&
      !firstCaptionAlreadyPreviewed
    ) {
      issues.push({
        kind: "slow_first_caption",
        turn: key,
        sequence: first.sequence,
        latency_millis: firstCaptionLatency,
        limit_millis: firstCaptionMillis,
      });
    }

    for (let index = 1; index < captions.length; index += 1) {
      const previous = captions[index - 1];
      const current = captions[index];
      const previousText = normalizeCaption(previous.payload?.surface);
      const currentText = normalizeCaption(current.payload?.surface);
      const gap = Number(current.timestamp_unix_ms) - Number(previous.timestamp_unix_ms);
      if (
        Number.isFinite(gap) &&
        gap >= longGapMillis &&
        previousText.length > 0 &&
        currentText.length > previousText.length &&
        currentText.startsWith(previousText)
      ) {
        issues.push({
          kind: "long_gap_same_turn_merge",
          turn: key,
          previous_sequence: previous.sequence,
          sequence: current.sequence,
          gap_millis: gap,
          limit_millis: longGapMillis,
        });
      }
    }

    const partials = captions.filter((record) => !record.payload?.is_final);
    const final = captions.findLast((record) => record.payload?.is_final);
    if (final && partials.length >= 2) {
      let stablePrefix = "";
      for (let index = 1; index < partials.length; index += 1) {
        const previousText = normalizeCaption(partials[index - 1].payload?.surface);
        const currentText = normalizeCaption(partials[index].payload?.surface);
        if (previousText.length >= 2 && currentText.startsWith(previousText)) {
          stablePrefix = previousText;
          break;
        }
      }
      const finalText = normalizeCaption(final.payload?.surface);
      if (stablePrefix && !finalText.startsWith(stablePrefix)) {
        issues.push({
          kind: "final_dropped_visible_prefix",
          turn: key,
          sequence: final.sequence,
          stable_prefix_characters: [...stablePrefix].length,
        });
      }
    }
  }

  for (const [key, record] of routedRevisions) {
    if (!appliedRevisions.has(key)) {
      issues.push({
        kind: "routed_caption_not_applied",
        session: sessionKey(record),
        sequence: record.sequence,
        revision: record.payload?.revision,
      });
    }
  }

  const counts = {};
  for (const record of records) counts[record.stage] = (counts[record.stage] ?? 0) + 1;
  const issueCounts = {};
  for (const issue of issues) issueCounts[issue.kind] = (issueCounts[issue.kind] ?? 0) + 1;

  return {
    result: issues.length === 0 ? "PASS" : "FAIL",
    record_count: records.length,
    stage_counts: counts,
    issue_counts: issueCounts,
    issues,
  };
}

export function parsePipelineJsonl(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid pipeline JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

export function defaultLogPath() {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "com.kotobabeacon.native",
    "diagnostics",
    "pipeline.jsonl",
  );
}

export function main(
  argv,
  {
    readFile = readFileSync,
    log = console.log,
    setExitCode = (code) => {
      process.exitCode = code;
    },
  } = {},
) {
  const failOnIssues = argv.includes("--fail-on-issues");
  const paths = argv.filter((argument) => !argument.startsWith("--"));
  const records = paths.length
    ? paths.flatMap((path) => parsePipelineJsonl(readFile(path, "utf8")))
    : parsePipelineJsonl(readFile(defaultLogPath(), "utf8"));
  const report = analyzePipelineRecords(records);
  log(JSON.stringify(report, null, 2));
  if (failOnIssues && report.result !== "PASS") setExitCode(1);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
