# Desktop Zenz verifier boundary

The desktop AzooKey path has an opt-in verifier boundary. The runtime switch
is read once at process start:

```sh
CAPTION_BRIDGE_ZENZ_VERIFIER=on   # on/true/1
CAPTION_BRIDGE_ZENZ_VERIFIER=off  # off/false/0 (default)
```

Values are trimmed and case-insensitive. An invalid value falls back to the
build default and emits one warning. The switch is deliberately separate from
`CAPTION_BRIDGE_ZENZ_LEFT_CONTEXT`: the latter controls whether prior caption
text is collected, while the verifier switch controls whether a verifier is
requested.

The first desktop wiring stage keeps the verifier slot empty. If the runtime
switch is enabled in this build, AzooKey still returns its dictionary result and
the shared conversion API reports `CapabilityUnavailable`; it never reports an
unverified result as `Verified`. The optional native model loader will populate
the same slot in a later stage and must be warmed at capture start, not during a
caption.

`PipelineStageEvent.zenzVerifier` contains counters only. `buildAvailable`,
`enabled`, and `loaded` distinguish a feature-off build, a runtime-off build,
and a runtime-on load failure. `calledCount` and `skippedCount` distinguish a
verifier call from the `require_left_context` policy skip. The remaining fields
mirror `VerificationState`, including `deadlineExceededCount` and both
`ExhaustedWith*` states. No prompt, caption, candidate, or context text is
included.

Left context is copied from `zenz_left_context()` into the shared
`SessionContext` by the AzooKey conversion boundary. The desktop layer does not
duplicate the policy check; an empty or whitespace-only snapshot is reported as
`SkippedByPolicy`. Context is reset at the existing capture/session boundaries.
