import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "judge-live-session.py");

const runJudge = (logBody) => {
  const directory = mkdtempSync(join(tmpdir(), "judge-live-session-"));
  const logPath = join(directory, "kotoba-beacon.log");
  writeFileSync(logPath, logBody);
  const result = spawnSync("python3", [script, "--log", logPath], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

test("prints the precommitted numeric gates", () => {
  const { status, stdout } = runJudge("");
  assert.equal(status, 0);
  assert.match(stdout, /gates success: max<=100 p95<=48 ge129=0/);
  assert.match(stdout, /gates strong_success: max<=40/);
  assert.match(stdout, /gates fail_long: max>=200 or ge129>=3/);
  assert.match(stdout, /gates fail_oversplit: p50<=8 or le4_share>=0.25/);
  assert.match(stdout, /verdict=insufficient/);
});

test("does not echo transcript text from normalize rows", () => {
  const { status, stdout } = runJudge(
    '[2026-08-16][01:00:00][INFO][pipeline_stage] stage=normalize model=azookey-rust ok=true duration_ms=120 utterance=parapper:abc:1:1 in="秘密の発話" out="秘密の発話" generation=1 input_chars=12 output_chars=12\n',
  );
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /秘密の発話/);
  assert.match(stdout, /normalize n=1/);
});
