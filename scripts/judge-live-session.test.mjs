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

const normalizeLine = (durationMs, inputChars, utterance = "u1") =>
  `[2026-08-16][01:00:00][INFO][pipeline_stage] stage=normalize model=azookey-rust ok=true duration_ms=${durationMs} utterance=parapper:${utterance}:1:1 in="x" out="x" generation=1 input_chars=${inputChars} output_chars=${inputChars}\n`;

test("prints the precommitted numeric gates", () => {
  const { status, stdout } = runJudge("");
  assert.equal(status, 0);
  assert.match(stdout, /gates success: max<=100 p95<=48 ge129=0/);
  assert.match(stdout, /gates strong_success: max<=40/);
  assert.match(stdout, /gates fail_long: max>=200 or ge129>=3/);
  assert.match(stdout, /gates fail_oversplit: p50<=8 or le4_share>=0.25/);
  assert.match(stdout, /gates normalize_slow: n>=20 and \(p95>3000 or max>10000\)/);
  assert.match(stdout, /gates stale_caption: age_ms>=8000/);
  assert.match(stdout, /gates overflow: overflowed=true; single_line and wrapped judged apart/);
  assert.match(stdout, /verdict=insufficient/);
  assert.match(stdout, /runtime_config verdict=unknown/);
  assert.match(stdout, /normalize n=0 p50=None p95=None max=None verdict=no_normalize_events/);
  assert.match(
    stdout,
    /overflow_single_line events=0 overflowed=0 max_content_width=None max_container_width=None verdict=no_overflow_events/,
  );
  assert.match(
    stdout,
    /overflow_wrapped events=0 overflowed=0 max_content_width=None max_container_width=None verdict=no_overflow_events/,
  );
});

test("does not echo transcript text from normalize rows", () => {
  const { status, stdout } = runJudge(
    '[2026-08-16][01:00:00][INFO][pipeline_stage] stage=normalize model=azookey-rust ok=true duration_ms=120 utterance=parapper:abc:1:1 in="秘密の発話" out="秘密の発話" generation=1 input_chars=12 output_chars=12\n',
  );
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /秘密の発話/);
  assert.match(stdout, /normalize n=1 p50=120 p95=120 max=120 verdict=insufficient/);
});

test("flags slow normalize only when n>=20 and p95 or max breaches the gate", () => {
  const fast = Array.from({ length: 20 }, (_, index) =>
    normalizeLine(100 + index, 20, `fast-${index}`),
  ).join("");
  // p95 index for n=20 is 18, so at least two slow samples are required.
  const slowP95 = Array.from({ length: 20 }, (_, index) =>
    normalizeLine(index < 18 ? 100 : 4000, 20, `p95-${index}`),
  ).join("");
  const slowMax = Array.from({ length: 20 }, (_, index) =>
    normalizeLine(index < 19 ? 100 : 12000, 20, `max-${index}`),
  ).join("");

  assert.match(runJudge(fast).stdout, /normalize n=20 .* verdict=ok/);
  assert.match(
    runJudge(slowP95).stdout,
    /normalize n=20 p50=100 p95=4000 max=4000 verdict=slow_normalize/,
  );
  assert.match(
    runJudge(slowMax).stdout,
    /normalize n=20 p50=100 p95=100 max=12000 verdict=slow_normalize/,
  );
});

test("reports long-utterance normalize latency on a separate line", () => {
  const body =
    Array.from({ length: 19 }, (_, index) => normalizeLine(100, 20, `short-${index}`)).join("") +
    normalizeLine(5000, 129, "long-1") +
    normalizeLine(7000, 200, "long-2");
  const { status, stdout } = runJudge(body);
  assert.equal(status, 0);
  assert.match(stdout, /normalize n=21 .* verdict=slow_normalize/);
  assert.match(stdout, /normalize_long n=2 p50=5000 p95=7000 max=7000/);
  assert.doesNotMatch(stdout, /secondary_p95_ok=/);
});

test("flags a caption held longer than eight seconds", () => {
  const { status, stdout } = runJudge(
    "[2026-08-16][01:00:00][INFO][frontend] [display] caption display lifecycle=visible age_ms=0 generation=2\n" +
      "[2026-08-16][01:00:09][INFO][frontend] [display] caption display lifecycle=hold age_ms=9000 generation=2\n",
  );
  assert.equal(status, 0);
  assert.match(
    stdout,
    /display visible=1 hold=1 clear=0 hold_cleared=0 hold_superseded=0 hold_unpaired=1 stale=1 max_age_ms=9000 verdict=stale_caption_held/,
  );
});

test("treats hold followed by clear as normal cleared residue", () => {
  const { status, stdout } = runJudge(
    "[2026-08-16][01:00:00][INFO][frontend] [display] caption display lifecycle=visible age_ms=0 generation=3\n" +
      "[2026-08-16][01:00:05][INFO][frontend] [display] caption display lifecycle=hold age_ms=1000 generation=3\n" +
      "[2026-08-16][01:00:10][INFO][frontend] [display] caption display lifecycle=clear age_ms=6000 generation=3\n",
  );
  assert.equal(status, 0);
  assert.match(
    stdout,
    /display visible=1 hold=1 clear=1 hold_cleared=1 hold_superseded=0 hold_unpaired=0 stale=0 max_age_ms=6000 verdict=cleared/,
  );
});

test("treats hold superseded by a later visible caption as normal speech-time hold", () => {
  const { status, stdout } = runJudge(
    "[2026-08-16][01:00:00][INFO][frontend] [display] caption display lifecycle=visible age_ms=0 generation=4\n" +
      "[2026-08-16][01:00:05][INFO][frontend] [display] caption display lifecycle=hold age_ms=500 generation=4\n" +
      "[2026-08-16][01:00:07][INFO][frontend] [display] caption display lifecycle=visible age_ms=0 generation=5\n",
  );
  assert.equal(status, 0);
  assert.match(
    stdout,
    /display visible=2 hold=1 clear=0 hold_cleared=0 hold_superseded=1 hold_unpaired=0 stale=0 max_age_ms=500 verdict=cleared/,
  );
});

test("judges single-line and wrapped overflow as separate verdicts", () => {
  const { status, stdout } = runJudge(
    "[2026-08-16][01:00:00][INFO][frontend] [display] caption overflow content_width=500 container_width=600 overflowed=false line_count=1\n" +
      "[2026-08-16][01:00:01][INFO][frontend] [display] caption overflow content_width=750 container_width=600 overflowed=true line_count=1\n" +
      "[2026-08-16][01:00:02][INFO][frontend] [display] caption overflow content_width=900 container_width=600 overflowed=true line_count=2\n",
  );
  assert.equal(status, 0);
  assert.match(
    stdout,
    /overflow_single_line events=2 overflowed=1 max_content_width=750 max_container_width=600 verdict=overflowed/,
  );
  assert.match(
    stdout,
    /overflow_wrapped events=1 overflowed=1 max_content_width=900 max_container_width=600 verdict=overflowed/,
  );
  assert.doesNotMatch(stdout, /^overflow /m);
});

test("reads every runtime setting from one log line", () => {
  const { status, stdout } = runJudge(
    "[2026-08-16][00:59:00][INFO][caption_bridge_lib] runtime config turn_check_silence_ms=320 normalizer=zenz-v3.2-small-gguf translator=hy-mt2-1.8b-gguf hold_clear_ms=5000 source_max_chars=28 translation_max_chars=48 streaming_interim_asr=false\n" +
      "[2026-08-16][01:00:00][INFO][caption_bridge_lib] runtime config turn_check_silence_ms=480 normalizer=azookey-rust translator=hy-mt2-7b-gguf hold_clear_ms=5000 source_max_chars=32 translation_max_chars=40 streaming_interim_asr=true\n",
  );
  assert.equal(status, 0);
  assert.match(
    stdout,
    /runtime_config turn_check_silence_ms=480 normalizer=azookey-rust translator=hy-mt2-7b-gguf hold_clear_ms=5000 source_max_chars=32 translation_max_chars=40 streaming_interim_asr=true rows=2/,
  );
  assert.doesNotMatch(stdout, /runtime_config verdict=unknown/);
});

test("reports fits when no overflow occurs across events", () => {
  const { status, stdout } = runJudge(
    "[2026-08-16][01:00:00][INFO][frontend] [display] caption overflow content_width=400 container_width=600 overflowed=false line_count=1\n",
  );
  assert.equal(status, 0);
  assert.match(
    stdout,
    /overflow_single_line events=1 overflowed=0 max_content_width=400 max_container_width=600 verdict=fits/,
  );
  assert.match(
    stdout,
    /overflow_wrapped events=0 overflowed=0 max_content_width=None max_container_width=None verdict=no_overflow_events/,
  );
});
