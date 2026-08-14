# caption-bridge-zenz-verifier

Native implementations of `caption_bridge_azookey_rust::DraftVerifier`.

## Dependency boundary

This crate is intentionally separate from `azookey-rust`. The latter is built
for WebAssembly by `azookey-wasm`; adding Candle to it would break that target.
The default build here is model-free and contains:

- `MockDraftVerifier`, a FIFO verifier double for retry/fallback integration;
- the exact Zenz v3 prompt (`EE02 left`, `EE07 right`, `EE00 input`, `EE01`);
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

## Forward-pass gate

`DraftVerifier` inference is deliberately not implemented yet. Before adding
it, Candle logits must reproduce the forked `kotoba-zenz-server` argmax for a
fixed prompt/token sequence. Tokenizer parity alone proves only identical input
IDs, not identical verification decisions.
