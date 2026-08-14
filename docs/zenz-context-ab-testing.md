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

Set the runtime override before launching the app:

```bash
launchctl setenv CAPTION_BRIDGE_ZENZ_LEFT_CONTEXT on
```

Fully quit and relaunch Kotoba Beacon so the new process inherits the setting. Select the Zenz model being evaluated, start a fresh capture, and speak the fixed script. Open the Debug panel and copy diagnostics after the run.

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

Change the runtime override without rebuilding:

```bash
launchctl setenv CAPTION_BRIDGE_ZENZ_LEFT_CONTEXT off
```

Fully quit and relaunch the app, then repeat the same fresh-session script and copy diagnostics. Zenz `normalize` events should report `enabled: false`, `characterCount: 0`, and `turnCount: 0`.

The runtime setting accepts `on`, `true`, or `1` for enabled and `off`, `false`, or `0` for disabled (case-insensitive). An invalid or unset runtime value falls back to the build default, which is enabled in normal builds. Always verify the effective value in `zenzContext.enabled` rather than assuming the override worked.

After the experiment, restore the normal default and relaunch:

```bash
launchctl unsetenv CAPTION_BRIDGE_ZENZ_LEFT_CONTEXT
```

For automated build-level baselines, `CAPTION_BRIDGE_DISABLE_ZENZ_LEFT_CONTEXT=1|true|on` remains available at compile time. A valid runtime override takes precedence over that build default.

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
