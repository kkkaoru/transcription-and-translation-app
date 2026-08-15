# caption-bridge-zenz-verifier

Native implementations of `caption_bridge_azookey_rust::DraftVerifier`.

## Dependency boundary

This crate is intentionally separate from `azookey-rust`. The latter is built
for WebAssembly by `azookey-wasm`; adding Candle to it would break that target.
The default build here is model-free and contains:

- `MockDraftVerifier`, a FIFO verifier double for retry/fallback integration;
- the exact Zenz v3 prompt (optional `EE02 left`, optional `EE07 right`, then `EE00 input`, `EE01`);
- a BOS-aware adapter over `caption-bridge-input-lm::tokenizer::ZenzTokenizer`.

The optional `candle` feature contains GGUFv3 validation and independently
loads `token_embd.weight` and `output.weight`. These tensors must not be tied:
the released model uses different quantization for them and tying silently
changes logits.

```sh
cargo test --manifest-path packages/zenz-verifier-rust/Cargo.toml
cargo test --manifest-path packages/zenz-verifier-rust/Cargo.toml --features candle
```

The workspace `check:all` gate deliberately runs the default, Candle-free
build. This continuously protects the lightweight/WASM-safe dependency
boundary without paying Candle's native compile cost on every full gate.
`bun run rust:zenz-verifier:candle` is the separate native-model gate and must
run whenever GGUF or forward code changes.

## Candle forward gate

The Candle feature includes a metadata-driven GPT-2 forward pass. It reads the
block count and dimensions from GGUF rather than assuming xsmall or small, uses
GPT-2's tanh GELU approximation (not `gelu_erf`), and keeps the Q5_K input
embedding separate from the Q6_K output projection.

Production targets `Miwa-Keita/zenz-v3.2-small-gguf` at revision
`c67e03e07d215c869f591b274c1631170d3e11fe`. The xsmall layout can load, but it
is not a product candidate because measurement found that it echoes proper-noun
readings as katakana. The real-model regression is visibly ignored when the
model is absent. Run it explicitly with:

```sh
ZENZ_V32_SMALL_GGUF=/path/to/ggml-model-Q5_K_M.gguf \
  cargo test --release --manifest-path packages/zenz-verifier-rust/Cargo.toml \
  --features candle --test candle_forward -- --ignored
```

That test pins a semantic result, not arbitrary logits: for the prompt
`BOS + EE00 + トウキョウ + EE01`, Candle predicts both tokens of candidate
`東京`, so the candidate verifies. The embedded verifier rejects the katakana
echo, returns the byte prefix `東`, then verifies `東京` after the caller's
 constrained lattice retry.

## Embedded integration API

The implementation is available only with feature `candle`:

```rust,ignore
pub fn EmbeddedZenzDraftVerifier::load(
    model_path: &Path,
    tokenizer_directory: &Path,
    model_revision: impl Into<String>,
    device: &candle_core::Device,
) -> Result<EmbeddedZenzDraftVerifier, EmbeddedVerifierLoadError>
```

Loading is eager. A failed GGUF/tokenizer load returns
`EmbeddedVerifierLoadError`, so no object can advertise capabilities for an
unavailable backend. `model_revision` is mandatory and should contain the
pinned model ID and revision; tokenizer identity is a deterministic fingerprint
of `vocab.json` and `merges.txt`. `load_elapsed()` reports model initialization
separately from conversion latency. Desktop wiring should load at recording
start when its opt-in toggle is enabled, and fail open if loading fails.

`capabilities()` currently reports:

| Capability | Value | Reason |
| --- | ---: | --- |
| `prefix_constraints` | `true` | The first token mismatch returns a raw UTF-8 byte output-prefix constraint. Lattice search remains the caller's responsibility. |
| `session_kv` | `false` | Each evaluation is full teacher-forced inference; no KV cache is implemented. Measured forward latency did not justify the extra complexity. |
| `right_context` | `true` | Non-empty right context is encoded with the upstream EE07 prompt form. |
| `max_candidates` | `1` | One trait call evaluates one `Draft`; n-best iteration belongs to the caller. |

Whether to invoke the verifier is caller policy. The current product rule
requires non-empty left context; no length/context threshold is duplicated
inside this crate.
