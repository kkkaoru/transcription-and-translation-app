# caption-bridge-input-lm

Rust port of azooKey's `EfficientNGram` — a Kneser-Ney smoothed, character-level
n-gram language model stored as MARISA tries.

## Status

**Working against the real model.** The codec, the Kneser-Ney smoothing, and a
MARISA reader are all in place, and the crate produces peaked, near-normalised
distributions from the published `input_n5_lm_v1` tries. What is *not* here is
the tokenizer and any integration into the caption pipeline; see
[Remaining work](#remaining-work).

This crate is deliberately standalone. It is **not** wired into the caption
pipeline and changes no existing behavior. It is **not** a dependency of
`azookey-rust`, because a MARISA C++ FFI there would break that crate's wasm
target — any future binding belongs here, behind an off-by-default feature.

## Reference

Ported from the vendored Swift source at
`submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/`:

| File | What was ported |
| --- | --- |
| `Trainer.swift` | Key/value codec and delimiters → [`codec`] |
| `Inference.swift` | `predict`, `bulkPredict` → [`model`] |

## Target model

- Repository: <https://huggingface.co/Miwa-Keita/input_n5_lm_v1>
- Pinned revision: `6153c4693ee202049b6cb834396e658562c147b3`
- Artifact: `input_n5_lm_v1.zip`, 120 372 659 bytes
- SHA-256: `0aaf326140a92d577b2020905346672b8cc4c47e63516328add0f197568aaf7a`
  (measured on the download below, not copied from anywhere)
- License: Apache-2.0

```sh
curl -L -o input_n5_lm_v1.zip \
  https://huggingface.co/Miwa-Keita/input_n5_lm_v1/resolve/6153c4693ee202049b6cb834396e658562c147b3/input_n5_lm_v1.zip
unzip input_n5_lm_v1.zip
```

The archive unpacks to `input_n5_lm_v1/` holding five tries with the shared
stem `lm`:

| File | Size | Used by `EfficientNGram` |
| --- | --- | --- |
| `lm_c_abc.marisa` | 90 MB | yes |
| `lm_c_bc.marisa` | 46 MB | no |
| `lm_u_xbc.marisa` | 22 MB | yes |
| `lm_u_abx.marisa` | 20 MB | yes |
| `lm_r_xbx.marisa` | 3 MB | yes |

azooKey ships this model with `n = 5`, `d = 0.75`, and a 6000-token vocabulary;
those are the values in `NgramParams::default()`. `start_token_id` is `2`
(`<s>`) — note that 0 is `[UNK]`, so defaulting it to zero would silently pad
with unknown tokens.

## Encoding

Every token becomes two `i8` digits in base 126 (`i8::MAX - 1`), each offset by
`+1` so no digit can collide with the two negative delimiters:

- `KEY_VALUE_DELIMITER` = `i8::MIN` (-128) separates a key from its value
- `PREDICTIVE_DELIMITER` = `i8::MIN + 1` (-127) sits immediately before a key's
  final token

Values occupy five digits, most significant first.

Two entry shapes share each trie:

```text
point:       key                      | KV   | value
predictive:  key[..last] | PRED | last| KV   | value
```

The predictive shape is what makes a single prefix search return every
one-token continuation of a context: because `encode_key(prefix ++ [w])`
equals `encode_key(prefix) ++ encode_key([w])`, inserting `PRED` before the
last token puts every continuation of `prefix` under the common prefix
`encode_key(prefix) ++ [PRED]`. The distinct delimiters also keep the two
entry families from matching each other's searches.

## Design

Trie access is abstracted behind [`NgramTrie`], whose only operation is
predictive search — exactly what MARISA offers, and all the model needs:

```rust
pub trait NgramTrie {
    fn predictive_search(&self, prefix: &[i8]) -> Vec<Vec<i8>>;
}
```

That indirection is what lets the smoothing math be tested against a hand-built
[`MemoryTrie`] with no 120 MB download.

The real reader lives in `marisa.rs` behind the off-by-default `rsmarisa`
feature. [`rsmarisa`](https://crates.io/crates/rsmarisa) is a **pure-Rust** port
of marisa-trie, binary-compatible with the C++ format, so this pulls in no C++
toolchain — which is what keeps a future wasm build viable and is why the
feature is safe to add here at all.

### Pointer-lifetime hazard

`rsmarisa::Agent::set_query_bytes` is a safe function that stores a **raw
pointer** into the slice rather than copying it. The query buffer must outlive
every `predictive_search` call that follows. Writing the natural

```rust
agent.set_query_bytes(&to_bytes(prefix));   // WRONG: temporary drops here
```

leaves a dangling pointer and silently returns zero matches. The empty prefix is
the one case that appears to work, because empty input stores a null pointer
instead — which makes this fail in a particularly misleading way.

## Correctness against the real model

Verified with `tests/real_model.rs` (skipped unless `INPUT_LM_MODEL_BASE` is
set) and the `examples/`:

- **Entries round-trip.** Keys pulled straight out of `lm_r_xbx.marisa` decode
  through the codec and read back through `lookup_value` with the same value.
- **Predictions are peaked.** Contexts drawn from the model concentrate mass
  far above the 1/6000 uniform floor.
- **Totals behave.** Sums run from `1.000028` on the dense BOS context to
  `1.117` on sparse ones.

That last point is worth stating plainly, because it looks like a bug and is
not. Kneser-Ney sums to exactly 1 only when the stored distinct-continuation
count `u_abx(ab)` equals `|{w : c(abw) > 0}|`. **The shipped tries are pruned**:
`examples/check_consistency.rs` finds `u_abx > present` in 37 of 40 sampled
contexts (129 vs 96, 31 vs 17, 139 vs 104, …). Low-count continuations were
dropped from `c_abc` while `u_abx` kept its pre-pruning count, so the back-off
weight is inflated by roughly `d * (u_abx - present) / c_abx`. Dense contexts
have a large `c_abx` and barely move; sparse ones drift up to ~12%.

The upstream Swift has the identical behavior — the formula was ported
verbatim. Exact normalisation *is* pinned, on consistent synthetic counts, in
`model::tests::consistent_counts_sum_to_exactly_one`, with the pruned shape
pinned alongside it.

## Tests

28 unit tests plus a doctest, all with no model file required. Kneser-Ney
probabilities are pinned against values computed by hand from the Swift formula
rather than from this implementation's own output.

Three breaks were injected and confirmed to fail the suite:

| Injected break | Tests that caught it |
| --- | --- |
| Predictive delimiter moved one digit right | 9 |
| Interpolation weight `gamma` halved | 3 |
| Query buffer dropped before search (the pointer hazard above) | 2 real-model |

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --features rsmarisa -- -D warnings
cargo fmt --check

# Against the real tries, once downloaded:
INPUT_LM_MODEL_BASE=~/.cache/caption-bridge-input-lm/input_n5_lm_v1/lm \
  cargo test --release --features rsmarisa --test real_model
```

### Examples

```sh
cargo run --release --features rsmarisa --example probe_model -- <base>
cargo run --release --features rsmarisa --example dump_keys -- <trie.marisa>
cargo run --release --features rsmarisa --example check_consistency -- <base>
```

## Remaining work

1. **Tokenizer.** `ZenzTokenizer` is a GPT-2 BPE tokenizer; its assets are
   vendored at `submodules/.../EfficientNGram/tokenizer/`. Without it, callers
   must supply token ids directly. Upstream hardcodes `vocabSize = 6000` behind
   a `// FIXME` rather than reading it from the tokenizer; `vocab.json` does in
   fact hold exactly 6000 entries (ids 0–5999), so the constant is correct
   today but is not self-maintaining.
2. **Performance.** `bulk_predict` scores all 6000 tokens per call and
   `predictive_search` allocates a `Vec` per hit. `tmp/plan.md` cites a p90 of
   ~18 ms for the Swift implementation; this port has not been benchmarked.
   Memory-mapping means first access to a cold trie also pays page-fault cost.
3. **Integration.** Per `tmp/plan.md`, the intended use is re-scoring kana
   N-best candidates between ASR output and kana-kanji conversion, driven by
   ASR-specific confusion rules rather than the keyboard-typo error model the
   upstream model shipped with. That stage does not exist yet.
4. **`lm_c_bc.marisa` is unused.** `Inference.swift` loads only four tries; the
   46 MB `c_bc` file is not among them. Worth understanding before shipping.

### Integration hazard

When this is eventually wired in, `azookey_input_text` must keep the **original
ASR reading**, not the corrected one. That field is the caption-merge key;
feeding it a corrected reading turns replace-in-place into append and
reintroduces the run-on captions fixed in `e393070`.
