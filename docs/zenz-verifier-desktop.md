# Desktop Zenz verifier boundary

The desktop AzooKey path has two independent gates for the embedded verifier:

1. The Cargo `candle` feature decides whether Candle and the verifier backend
   are included in the binary. It is off by default.
2. `CAPTION_BRIDGE_ZENZ_VERIFIER` decides whether an included backend is used
   at runtime. It is also off by default.

Turning on only one gate is not enough: a feature-off build cannot load the
backend, and a feature-on build remains runtime-disabled until the environment
switch is enabled.

The runtime switch is read once at process start:

```sh
CAPTION_BRIDGE_ZENZ_VERIFIER=on   # on/true/1
CAPTION_BRIDGE_ZENZ_VERIFIER=off  # off/false/0 (default)
```

Values are trimmed and case-insensitive. An invalid value falls back to the
build default and emits one warning. The switch is deliberately separate from
`CAPTION_BRIDGE_ZENZ_LEFT_CONTEXT`: the latter controls whether prior caption
text is collected, while the verifier switch controls whether a verifier is
requested.

When the `candle` feature is absent, an enabled switch keeps the verifier slot
empty. AzooKey still returns its dictionary result and the shared conversion API
reports `CapabilityUnavailable`; it never reports an unverified result as
`Verified`.

With the feature present, the model and tokenizer are loaded at capture start,
before microphone chunks can arrive. A load failure emits one warning, records
`loadFailureCount` and a short `loadFailureReason` identifier (`model_not_found`,
`tokenizer_mismatch`, `decode_error`, or `other`), and keeps capture running with
the dictionary fallback. Loading is never deferred until a caption is being
rendered.

The default model is `zenz-v3.2-small-gguf` in the desktop model-runtime
directory. For development and measurement, `config.models.paths["zenz-v3.2-small-gguf"]`
or `CAPTION_BRIDGE_ZENZ_MODEL_PATH` may override the GGUF file; a directory
override is resolved with the model's standard filename. The model path is not
currently editable from the UI, so configuration or environment is required.
`CAPTION_BRIDGE_MODEL_RUNTIME_DIR` can override the default model-runtime
directory when running outside the packaged Tauri app.

`PipelineStageEvent.zenzVerifier` contains counters only. `buildAvailable`,
`enabled`, and `loaded` distinguish a feature-off build, a runtime-off build,
and a runtime-on load failure. `loadFailureCount` and `loadFailureReason` make
the failure observable without exposing paths or model errors. `calledCount` and
`skippedCount` distinguish a verifier call from the `require_left_context`
policy skip. The remaining fields mirror `VerificationState`, including
`deadlineExceededCount` and both `ExhaustedWith*` states. No prompt, caption,
candidate, or context text is included.

The normal quality gate lints the desktop with its default features so it does
not compile Candle or the `onig` C dependency. The optional Candle backend is
checked outside that gate with:

```sh
CAPTION_BRIDGE_DESKTOP_CANDLE_LINT=1 bun run rust:lint
```

The verifier crate's standalone Candle test/lint remains available through
`bun run rust:zenz-verifier:candle`.

Left context is copied from `zenz_left_context()` into the shared
`SessionContext` by the AzooKey conversion boundary. The desktop layer does not
duplicate the policy check; an empty or whitespace-only snapshot is reported as
`SkippedByPolicy`. Context is reset at the existing capture/session boundaries.
