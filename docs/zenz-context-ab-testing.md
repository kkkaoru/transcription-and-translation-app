# Zenz left-context A/B test

This procedure compares Zenz normalization latency with and without preceding confirmed captions. Left context is enabled by default. The experiment records counts only; it never adds the preceding caption text to `zenzContext` diagnostics.

## Keep the two runs comparable

- Use the same Mac, Zenz model, microphone, endpoint, and spoken script.
- Close other CPU/GPU-heavy applications.
- Start a new capture session for each run.
- Speak several turns so later turns have context. The first turn normally reports zero context.
- Include both interim and final results. Interim captions run on the approximately 400 ms update cycle.
- Discard model/server warm-up samples before comparing latency.
- Use non-sensitive test speech because existing general pipeline diagnostics can contain current-stage input/output snippets.

## Run A: context enabled (default)

Build without the disable flag:

```bash
env -u CAPTION_BRIDGE_DISABLE_ZENZ_LEFT_CONTEXT bun run build:app:release
```

Launch the resulting app, select the Zenz model being evaluated, start a fresh capture, and speak the fixed script. Open the Debug panel and copy diagnostics after the run.

A Zenz `normalize` event should contain metadata shaped like:

```json
{
  "durationMs": 123,
  "zenzContext": {
    "enabled": true,
    "isFinal": false,
    "characterCount": 18,
    "turnCount": 2,
    "discardedSessionCount": 1
  }
}
```

`characterCount > 0` and `turnCount > 0` confirm that left context was actually supplied. The counts describe only the suffix that entered the prompt (at most 40 grapheme clusters), not all retained history.

## Run B: context disabled

Rebuild with the compile-time disable flag:

```bash
CAPTION_BRIDGE_DISABLE_ZENZ_LEFT_CONTEXT=1 bun run build:app:release
```

Repeat the same fresh-session script and copy diagnostics. Zenz `normalize` events should report `enabled: false`, `characterCount: 0`, and `turnCount: 0`.

The accepted disable values are `1`, `true`, and `on`. Any other value, or an unset variable, keeps context enabled. Because this is a compile-time flag, changing it requires rebuilding the Rust desktop app.

## Compare the results

Filter both diagnostic copies to Zenz `normalize` events and compare `durationMs` under the same `isFinal` group:

| Group | Diagnostic filter | Primary comparison |
| --- | --- | --- |
| Interim | `zenzContext.isFinal == false` | Median and p95 `durationMs`; count and percentage at or above 400 ms |
| Final | `zenzContext.isFinal == true` | Median and p95 `durationMs` |

For the enabled run, also group latency by `characterCount` or `turnCount`. This shows whether longer context correlates with slower normalization. Do not mix first-turn zero-context samples with non-zero-context samples when estimating the context cost.

Compare several repeated runs rather than one sample. A useful latency result records:

- Zenz model ID and build mode;
- number of samples after warm-up;
- interim/final median and p95 for each variant;
- interim samples at or above the 400 ms update period;
- context character/turn ranges;
- the final `discardedSessionCount` as a session-reset sanity check.

If context materially worsens interim latency but final latency remains acceptable, the diagnostics provide the evidence needed to evaluate a future policy of supplying context only for final normalization. This procedure does not measure conversion accuracy; use the separate accuracy-corpus workflow for that comparison.
