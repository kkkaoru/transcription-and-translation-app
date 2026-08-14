# Partial-window ASR benchmark notes

## 2026-08-14: eight-second segment cap

The benchmark used `top -stats pid,cpu,...` on macOS. Process CPU is reported
per logical CPU: 100% represents one fully occupied logical CPU, and a
multi-threaded process can exceed 100%. The raw samples include values above
100%, so the results must not be interpreted as a percentage of total machine
capacity.

With `MAX_PHRASE_MILLIS=8_000`, continuous speech produced 15 cap skips from
63 opportunities (23.81%), down from 46/68 (67.65%) with the 25-second cap.
Partial-window decode p95 was 54 ms for the normal fixture and 96 ms for the
continuous fixture. Neither run throttled or skipped because a decode was
still in flight.

CPU cost was material and should remain visible in future product decisions:

| Scenario | OFF mean / p95 | ON mean / p95 | ON - OFF |
| --- | --- | --- | --- |
| Normal conversation | 8.25% / 24.6% | 22.77% / 65.9% | +14.52 / +41.3 points |
| Continuous speech | 7.48% / 74.1% | 23.87% / 89.9% | +16.40 / +15.8 points |

The raw artifacts are intentionally outside the repository because they
contain machine-specific runtime data.

## Backlog

- Fix final-caption E2E measurement. The current replay report subtracts
  `speech_start_at` from `asr_final_at`, but the generated fixtures can remain
  one open utterance. The resulting p95 therefore tracks fixture/segment
  duration (16–30 seconds) rather than the desired latency from end of speech
  to final caption. Record an explicit end-of-speech timestamp and require more
  than one final sample before applying the 50 ms comparison threshold.
- Until that fix lands, do not use `final_caption_p95_delta_limit` to accept or
  reject a run. The 2026-08-14 normal comparison returned exit 1 for a 51 ms
  delta against a 50 ms limit, but both inputs were approximately 30 seconds
  and the metric measured fixture duration. That result was explicitly
  excluded from the enablement decision; decode p95, throttle, in-flight skip,
  cap-skip rate, and CPU remained the valid signals.
