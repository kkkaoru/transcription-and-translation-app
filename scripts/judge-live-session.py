#!/usr/bin/env python3
"""Judge a Kotoba Beacon live session against precommitted numeric gates.

Does not print transcript text, paths, or session UUIDs.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

NORMALIZE_RE = re.compile(
    r"\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\].*"
    r"stage=normalize .* ok=(true|false) duration_ms=(\d+) "
    r"utterance=(\S+) .* input_chars=(\d+) output_chars=(\d+)"
)
TURN_FINAL_RE = re.compile(
    r"\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\].*"
    r"turn\.final received turn_session_id=(\d+) turn_id=(\d+) "
    r"is_final=(true|false) generation=(\d+)"
)
DECISION_RE = re.compile(
    r"\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\].*"
    r"translation decision=(spawn|skip) reason=(\S+) "
    r"turn_session_id=(\d+) turn_id=(\d+) generation=(\d+)"
)
RESULT_RE = re.compile(
    r"\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\].*"
    r"translation result=(completed|completed-noop|failed) "
    r"disposition=(publishable|discarded) turn_id=(\S+) generation=(\d+)"
)
TRANSLATE_STAGE_RE = re.compile(
    r"\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\].*"
    r"stage=translate .* ok=(true|false) duration_ms=(\d+)"
)

SUCCESS_MAX = 100
SUCCESS_P95 = 48
SUCCESS_LONG_TURNS = 0
LONG_CHARS = 129
STRONG_MAX = 40
FAIL_MAX = 200
FAIL_LONG_TURNS = 3
OVERSPLIT_MEDIAN = 8
OVERSPLIT_TINY_MAX = 4
OVERSPLIT_TINY_SHARE = 0.25
SECONDARY_NORMALIZE_P95_MS = 3000


def percentile(values: list[int], q: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((q / 100) * (len(ordered) - 1)))))
    return ordered[index]


def parse_stamp(date: str, time: str) -> str:
    return f"{date}T{time}"


def in_window(stamp: str, after: str | None, before: str | None) -> bool:
    if after and stamp < after:
        return False
    if before and stamp > before:
        return False
    return True


def judge_turns(max_per_turn: list[int]) -> dict[str, object]:
    tiny_share = (
        sum(1 for value in max_per_turn if value <= OVERSPLIT_TINY_MAX) / len(max_per_turn)
        if max_per_turn
        else 0.0
    )
    observed = {
        "turns": len(max_per_turn),
        "max": max(max_per_turn) if max_per_turn else None,
        "p50": percentile(max_per_turn, 50),
        "p95": percentile(max_per_turn, 95),
        "ge129": sum(1 for value in max_per_turn if value >= LONG_CHARS),
        "ge28": sum(1 for value in max_per_turn if value >= 28),
        "le4_share": round(tiny_share, 3),
    }
    success = bool(
        max_per_turn
        and observed["max"] is not None
        and observed["p95"] is not None
        and observed["max"] <= SUCCESS_MAX
        and observed["p95"] <= SUCCESS_P95
        and observed["ge129"] == SUCCESS_LONG_TURNS
    )
    strong = success and observed["max"] is not None and observed["max"] <= STRONG_MAX
    fail_long = bool(
        observed["max"] is not None
        and (observed["max"] >= FAIL_MAX or observed["ge129"] >= FAIL_LONG_TURNS)
    )
    oversplit = bool(
        max_per_turn
        and (
            (observed["p50"] is not None and observed["p50"] <= OVERSPLIT_MEDIAN)
            or tiny_share >= OVERSPLIT_TINY_SHARE
        )
    )
    if not max_per_turn:
        verdict = "insufficient"
    elif fail_long and oversplit:
        verdict = "fail_mixed"
    elif fail_long:
        verdict = "fail_long"
    elif oversplit:
        verdict = "fail_oversplit"
    elif strong:
        verdict = "strong_success"
    elif success:
        verdict = "success"
    else:
        verdict = "inconclusive"
    return {"verdict": verdict, **observed}


def judge_translation(
    finals: list[tuple[str, ...]],
    decisions: list[tuple[str, ...]],
    results: list[tuple[str, ...]],
    translate_stages: list[tuple[str, ...]],
) -> dict[str, object]:
    decision_counts: dict[str, int] = defaultdict(int)
    for row in decisions:
        decision_counts[f"{row[2]}:{row[3]}"] += 1
    result_counts: dict[str, int] = defaultdict(int)
    for row in results:
        result_counts[f"{row[2]}:{row[3]}"] += 1
    translate_ok = sum(1 for row in translate_stages if row[2] == "true")
    received = len(finals)
    spawned = sum(1 for row in decisions if row[2] == "spawn")
    skipped = sum(1 for row in decisions if row[2] == "skip")
    completed = sum(1 for row in results if row[2].startswith("completed"))
    publishable = sum(1 for row in results if row[3] == "publishable")
    discarded = sum(1 for row in results if row[3] == "discarded")
    if received == 0:
        verdict = "no_final_received"
    elif spawned == 0:
        verdict = "final_received_no_spawn"
    elif completed == 0:
        verdict = "spawned_not_completed"
    elif publishable == 0:
        verdict = "completed_not_publishable"
    else:
        verdict = "spawned_and_publishable"
    return {
        "verdict": verdict,
        "turn_final_received": received,
        "decisions": spawned + skipped,
        "spawn": spawned,
        "skip": skipped,
        "results": len(results),
        "completed": completed,
        "publishable": publishable,
        "discarded": discarded,
        "stage_translate": len(translate_stages),
        "stage_translate_ok": translate_ok,
        "decision_reasons": dict(sorted(decision_counts.items())),
        "result_kinds": dict(sorted(result_counts.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--log",
        default=str(Path.home() / "Library/Logs/com.kotobabeacon.desktop/kotoba-beacon.log"),
    )
    parser.add_argument("--after", help="Inclusive stamp, YYYY-MM-DDTHH:MM:SS")
    parser.add_argument("--before", help="Inclusive stamp, YYYY-MM-DDTHH:MM:SS")
    args = parser.parse_args()
    path = Path(args.log)
    if not path.is_file():
        print("missing_log EXIT=1")
        return 1

    normalize_rows: list[tuple[str, str, int, str]] = []
    finals: list[tuple[str, ...]] = []
    decisions: list[tuple[str, ...]] = []
    results: list[tuple[str, ...]] = []
    translate_stages: list[tuple[str, ...]] = []
    for line in path.read_text(errors="replace").splitlines():
        if match := NORMALIZE_RE.search(line):
            stamp = parse_stamp(match.group(1), match.group(2))
            if in_window(stamp, args.after, args.before):
                normalize_rows.append(
                    (match.group(5), match.group(3), int(match.group(4)), match.group(6))
                )
            continue
        if match := TURN_FINAL_RE.search(line):
            stamp = parse_stamp(match.group(1), match.group(2))
            if in_window(stamp, args.after, args.before):
                finals.append(match.group(1, 2, 3, 4, 6))
            continue
        if match := DECISION_RE.search(line):
            stamp = parse_stamp(match.group(1), match.group(2))
            if in_window(stamp, args.after, args.before):
                decisions.append(match.group(1, 2, 3, 4, 5, 6, 7))
            continue
        if match := RESULT_RE.search(line):
            stamp = parse_stamp(match.group(1), match.group(2))
            if in_window(stamp, args.after, args.before):
                results.append(match.group(1, 2, 3, 4, 5, 6))
            continue
        if match := TRANSLATE_STAGE_RE.search(line):
            stamp = parse_stamp(match.group(1), match.group(2))
            if in_window(stamp, args.after, args.before):
                translate_stages.append(match.group(1, 2, 3, 4))

    turns: dict[str, list[int]] = defaultdict(list)
    durations: list[int] = []
    for utterance, _ok, duration_ms, input_chars in normalize_rows:
        turns[utterance].append(int(input_chars))
        durations.append(duration_ms)
    max_per_turn = [max(values) for values in turns.values()]
    turn_report = judge_turns(max_per_turn)
    translation_report = judge_translation(finals, decisions, results, translate_stages)
    normalize_p95 = percentile(durations, 95)
    print("gates success: max<=100 p95<=48 ge129=0")
    print("gates strong_success: max<=40")
    print("gates fail_long: max>=200 or ge129>=3")
    print("gates fail_oversplit: p50<=8 or le4_share>=0.25")
    print(
        "turn "
        + " ".join(f"{key}={value}" for key, value in turn_report.items() if key != "verdict")
        + f" verdict={turn_report['verdict']}"
    )
    print(
        "normalize n="
        f"{len(normalize_rows)} p50={percentile(durations, 50)} "
        f"p95={normalize_p95} max={max(durations) if durations else None} "
        f"secondary_p95_ok={bool(normalize_p95 is not None and normalize_p95 <= SECONDARY_NORMALIZE_P95_MS)}"
    )
    print(
        "translation "
        + " ".join(
            f"{key}={value}"
            for key, value in translation_report.items()
            if key not in {"decision_reasons", "result_kinds", "verdict"}
        )
        + f" verdict={translation_report['verdict']}"
    )
    if translation_report["decision_reasons"]:
        print(
            "translation_reasons "
            + " ".join(f"{key}={value}" for key, value in translation_report["decision_reasons"].items())
        )
    if translation_report["result_kinds"]:
        print(
            "translation_results "
            + " ".join(f"{key}={value}" for key, value in translation_report["result_kinds"].items())
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
