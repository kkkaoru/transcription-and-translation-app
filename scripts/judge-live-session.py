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
DISPLAY_RE = re.compile(
    r"caption display lifecycle=(visible|hold|clear) age_ms=(\d+) generation=(\S+)"
)
OVERFLOW_RE = re.compile(
    r"caption overflow content_width=(\d+) container_width=(\d+) "
    r"overflowed=(true|false) line_count=(\d+)"
)
STALE_DISPLAY_MS = 8000
RUNTIME_CONFIG_RE = re.compile(
    r"runtime config(?: app_version=(\S+) build_id=(\S+))? "
    r"turn_check_silence_ms=(\d+) normalizer=(\S+) "
    r"translator=(\S+) hold_clear_ms=(\d+) source_max_chars=(\d+) "
    r"translation_max_chars=(\d+) streaming_interim_asr=(true|false)"
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
NORMALIZE_LATENCY_N_MIN = 20
NORMALIZE_LATENCY_P95_MS = 3000
NORMALIZE_LATENCY_MAX_MS = 10000


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


def judge_normalize(durations: list[int], long_durations: list[int]) -> dict[str, object]:
    """Judge late-session normalize latency without mixing long-utterance stats."""
    p50 = percentile(durations, 50)
    p95 = percentile(durations, 95)
    maximum = max(durations) if durations else None
    slow = bool(
        len(durations) >= NORMALIZE_LATENCY_N_MIN
        and (
            (p95 is not None and p95 > NORMALIZE_LATENCY_P95_MS)
            or (maximum is not None and maximum > NORMALIZE_LATENCY_MAX_MS)
        )
    )
    if not durations:
        verdict = "no_normalize_events"
    elif len(durations) < NORMALIZE_LATENCY_N_MIN:
        verdict = "insufficient"
    elif slow:
        verdict = "slow_normalize"
    else:
        verdict = "ok"
    report: dict[str, object] = {
        "verdict": verdict,
        "n": len(durations),
        "p50": p50,
        "p95": p95,
        "max": maximum,
    }
    if long_durations:
        report["long_n"] = len(long_durations)
        report["long_p50"] = percentile(long_durations, 50)
        report["long_p95"] = percentile(long_durations, 95)
        report["long_max"] = max(long_durations)
    return report


def judge_display(events: list[tuple[str, int, str]]) -> dict[str, object]:
    """Separate normal speech-time holds from unpaired residue via hold/clear pairing.

    A hold is normal when later cleared, or superseded by a new visible caption
    (continuous speech cancels the timer without logging clear). age_ms >= 8000
    remains the stale gate regardless of pairing.
    """
    visible = sum(1 for event in events if event[0] == "visible")
    hold = sum(1 for event in events if event[0] == "hold")
    clear = sum(1 for event in events if event[0] == "clear")
    stale = [event for event in events if event[1] >= STALE_DISPLAY_MS]
    pending_holds = 0
    hold_cleared = 0
    hold_superseded = 0
    for lifecycle, _age_ms, _generation in events:
        if lifecycle == "hold":
            pending_holds += 1
        elif lifecycle == "clear" and pending_holds > 0:
            pending_holds -= 1
            hold_cleared += 1
        elif lifecycle == "visible" and pending_holds > 0:
            hold_superseded += pending_holds
            pending_holds = 0
    if not events:
        verdict = "no_display_events"
    elif stale:
        verdict = "stale_caption_held"
    elif pending_holds > 0:
        verdict = "hold_without_clear"
    else:
        verdict = "cleared"
    return {
        "verdict": verdict,
        "visible": visible,
        "hold": hold,
        "clear": clear,
        "hold_cleared": hold_cleared,
        "hold_superseded": hold_superseded,
        "hold_unpaired": pending_holds,
        "stale": len(stale),
        "max_age_ms": max((event[1] for event in events), default=None),
    }


def judge_overflow_bucket(
    events: list[tuple[int, int, bool, int]],
) -> dict[str, object]:
    overflowed = [event for event in events if event[2]]
    max_content = max((event[0] for event in events), default=None)
    max_container = max((event[1] for event in events), default=None)
    if not events:
        verdict = "no_overflow_events"
    elif overflowed:
        verdict = "overflowed"
    else:
        verdict = "fits"
    return {
        "verdict": verdict,
        "events": len(events),
        "overflowed": len(overflowed),
        "max_content_width": max_content,
        "max_container_width": max_container,
    }


def judge_overflow(
    events: list[tuple[int, int, bool, int]],
) -> tuple[dict[str, object], dict[str, object]]:
    """Judge single-line vs wrapped overflow separately.

    line_count=1 means wrapping did not take effect; line_count>=2 means the
    caption wrapped and still did not fit. Causes and fixes differ, so they
    must not share one verdict.
    """
    single_line = [event for event in events if event[3] <= 1]
    wrapped = [event for event in events if event[3] >= 2]
    return judge_overflow_bucket(single_line), judge_overflow_bucket(wrapped)


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
    display_events: list[tuple[str, int, str]] = []
    overflow_events: list[tuple[int, int, bool, int]] = []
    runtime_configs: list[tuple[str, str, str, str, str, str, str]] = []
    for line in path.read_text(errors="replace").splitlines():
        if match := RUNTIME_CONFIG_RE.search(line):
            runtime_configs.append(
                (
                    match.group(1) or "unknown",
                    match.group(2) or "unknown",
                    match.group(3),
                    match.group(4),
                    match.group(5),
                    match.group(6),
                    match.group(7),
                    match.group(8),
                    match.group(9),
                )
            )
            continue
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
            continue
        if match := DISPLAY_RE.search(line):
            display_events.append((match.group(1), int(match.group(2)), match.group(3)))
            continue
        if match := OVERFLOW_RE.search(line):
            overflow_events.append(
                (
                    int(match.group(1)),
                    int(match.group(2)),
                    match.group(3) == "true",
                    int(match.group(4)),
                )
            )

    turns: dict[str, list[int]] = defaultdict(list)
    durations: list[int] = []
    long_durations: list[int] = []
    for utterance, _ok, duration_ms, input_chars in normalize_rows:
        chars = int(input_chars)
        turns[utterance].append(chars)
        durations.append(duration_ms)
        if chars >= LONG_CHARS:
            long_durations.append(duration_ms)
    max_per_turn = [max(values) for values in turns.values()]
    turn_report = judge_turns(max_per_turn)
    normalize_report = judge_normalize(durations, long_durations)
    translation_report = judge_translation(finals, decisions, results, translate_stages)
    display_report = judge_display(display_events)
    overflow_single_report, overflow_wrapped_report = judge_overflow(overflow_events)
    print("gates success: max<=100 p95<=48 ge129=0")
    print("gates strong_success: max<=40")
    print("gates fail_long: max>=200 or ge129>=3")
    print("gates fail_oversplit: p50<=8 or le4_share>=0.25")
    print(
        "gates normalize_slow: "
        f"n>={NORMALIZE_LATENCY_N_MIN} and "
        f"(p95>{NORMALIZE_LATENCY_P95_MS} or max>{NORMALIZE_LATENCY_MAX_MS})"
    )
    print("gates stale_caption: age_ms>=8000")
    print("gates overflow: overflowed=true; single_line and wrapped judged apart")
    if runtime_configs:
        latest = runtime_configs[-1]
        print(
            "runtime_config "
            f"app_version={latest[0]} "
            f"build_id={latest[1]} "
            f"turn_check_silence_ms={latest[2]} "
            f"normalizer={latest[3]} "
            f"translator={latest[4]} "
            f"hold_clear_ms={latest[5]} "
            f"source_max_chars={latest[6]} "
            f"translation_max_chars={latest[7]} "
            f"streaming_interim_asr={latest[8]} "
            f"rows={len(runtime_configs)}"
        )
    else:
        print("runtime_config verdict=unknown")
    print(
        "turn "
        + " ".join(f"{key}={value}" for key, value in turn_report.items() if key != "verdict")
        + f" verdict={turn_report['verdict']}"
    )
    print(
        "normalize "
        + " ".join(
            f"{key}={value}"
            for key, value in normalize_report.items()
            if key != "verdict" and not str(key).startswith("long_")
        )
        + f" verdict={normalize_report['verdict']}"
    )
    if "long_n" in normalize_report:
        print(
            "normalize_long "
            f"n={normalize_report['long_n']} "
            f"p50={normalize_report['long_p50']} "
            f"p95={normalize_report['long_p95']} "
            f"max={normalize_report['long_max']}"
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
    print(
        "display "
        + " ".join(
            f"{key}={value}" for key, value in display_report.items() if key != "verdict"
        )
        + f" verdict={display_report['verdict']}"
    )
    print(
        "overflow_single_line "
        + " ".join(
            f"{key}={value}"
            for key, value in overflow_single_report.items()
            if key != "verdict"
        )
        + f" verdict={overflow_single_report['verdict']}"
    )
    print(
        "overflow_wrapped "
        + " ".join(
            f"{key}={value}"
            for key, value in overflow_wrapped_report.items()
            if key != "verdict"
        )
        + f" verdict={overflow_wrapped_report['verdict']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
