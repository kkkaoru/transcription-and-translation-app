# caption-bridge-input-lm

Rust port of azooKey's `EfficientNGram` — a Kneser-Ney smoothed, character-level
n-gram language model stored as MARISA tries.

## Status

**Working against the real model.** The codec, the Kneser-Ney smoothing, a
MARISA reader, and the GPT-2 byte-level BPE tokenizer are all in place, and the
crate produces peaked, near-normalised distributions from the published
`input_n5_lm_v1` tries. The remaining gap is integration into the caption
pipeline; see [Remaining work](#remaining-work).

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
| `Tokenizer.swift` | GPT-2 byte-level BPE fast path → [`tokenizer`] |

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

## Tokenizer

The model's input vocabulary comes from a **GPT-2 byte-level BPE tokenizer**
(`ku-nlp/gpt2-small-japanese-char`), whose assets are vendored in
`submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer/`
(`vocab.json` = 6000 tokens, `merges.txt` = 5764 merges, both loaded at
runtime from the submodule; the byte-to-unicode table is generated in Rust — no
JSON or crate copies). The port lives in `src/tokenizer.rs` and mirrors the
public surface of `ZenzTokenizer` in `Tokenizer.swift`: `encode` (the per-scalar
fast path), `encode_slow` (whole-string BPE), `decode`, `start_token_id` (2),
`end_token_id` (3), and `vocab_size` (6000).

### Is full BPE needed, or is per-scalar encoding faithful?

**Per-scalar encoding (the Swift fast path) is byte-for-byte identical to full
BPE for this model, so full cross-scalar merging is *not* needed.** This was not
assumed — it was decided from the actual assets, on two structural facts plus an
empirical sweep:

1. The GPT-2 byte-map sends every UTF-8 byte above `0x7F` to a Latin-1 char in
   `[0xC0, 0xFF]`. Every byte in `[0xC0, 0xDF]` (possible *middle* bytes of a
   multi-byte scalar) has **no single-char vocabulary entry**, so it can never
   terminate a merge by itself.
2. A multi-byte scalar's byte-map always starts with `ã` (3-byte scalars) or
   `â`/`Ä`/`Ă` (2-byte). Checking all **5764** merges: **no merge pair has a
   lead-byte char as its second half** (empirically verified against
   `merges.txt`), so no merge can swallow the first byte of the *following*
   scalar while the current scalar is mid-merge.

Consequences:

- The byte-level BPE never straddles a Unicode scalar boundary, so
  `encode("あしたのてんきははれ") == encode_slow(...)` for every Japanese /
  kana / kanji / romaji string that only uses scalars present in the vocab.
- A scalar that is *not* in the vocab (e.g. an ASCII space, byte 0x20 maps to
  `\u{0120}` which has no token) becomes `[UNK]` = 0 on both paths — exactly
  the reference fast path behavior. `decode([0])` yields the literal
  `"[UNK]"`, as the Swift decoder does.
- The fast path caches one `Vec<id>` per scalar, identical to the Swift
  `FastTokenizerPathState`.

This decision is pinned in tests `fast_and_slow_paths_agree_*` and
`known_ids_pin_character_encoding` (kana → expected ids 277/244/249/240), and
end-to-end in `tests/real_model.rs`: encoding `イシテル` and feeding it to
`bulk_predict` yields a peaked distribution (peak ≈ 0.131 vs uniform 0.000167,
~786×) whose total sums to ≈ 1.005.

A note on data: the pruned `c_abc` trie has **no counts** for many common
*kana* sequences (e.g. `あした`, `今日`), because the training corpus was ASCII
romaji / katakana-leaning input, not kana prose. `イシテル` is a genuine,
dense context; `あしたのてんきははれ` back-ends to the uniform floor (exactly
as the upstream model does). The tokenizer itself is correct regardless — the
absence of a count is a model-data property, not a tokenizer bug.

### Asset strategy

`vocab.json` and `merges.txt` are read from the git submodule path at runtime
(`../../submodules/.../tokenizer` relative to `CARGO_MANIFEST_DIR`). If the
submodule is not checked out, `ZenzTokenizer::from_submodule()` returns `None`
(a typed absence) and callers fall back to `from_dir` with their own copy or an
embedded loader. This avoids copying ~460 KB of JSON into the repo while keeping
the failure mode explicit and panic-free. The only new dependency is
`serde_json` (for parsing `vocab.json`); the byte table and BPE merge are
hand-rolled.

## Design

Trie access is abstracted behind [`NgramTrie`], whose only operation is
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

43 unit tests plus a doctest, all with no model file required. Kneser-Ney
probabilities are pinned against values computed by hand from the Swift formula
rather than from this implementation's own output. The tokenizer suite pins the
GPT-2 byte table (all 256 bytes round-trip), the per-scalar fast path vs the
whole-string BPE slow path (equal on Japanese), kana → expected ids
(あ=277, し=244, た=249, の=240), decode round-trips, `[UNK]` handling, and
the cache.

Three breaks were injected and confirmed to fail the suite, plus two
tokenizer-specific ones:

| Injected break | Tests that caught it |
| --- | --- |
| Predictive delimiter moved one digit right | 9 |
| Interpolation weight `gamma` halved | 3 |
| Query buffer dropped before search (the pointer hazard above) | 2 real-model |
| Fast path changed from per-scalar BPE to per-byte lookup | 3 (`known_ids_pin_character_encoding`, `fast_and_slow_paths_agree_*`, `an_emoji_scalar_*`) |
| Byte table corrupted (space byte forced to `' '`) | 2 (`known_ids_pin_character_encoding`, `an_emoji_scalar_*`) |

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
cargo run --release --features rsmarisa --example rescore_measure -- <base>
cargo run --release --features rsmarisa --example rescore_sweep -- <base>
```

## Remaining work

1. **Performance.** `bulk_predict` scores all 6000 tokens per call and
   `predictive_search` allocates a `Vec` per hit. `tmp/plan.md` cites a p90 of
   ~18 ms for the Swift implementation; this port has not been benchmarked.
   Memory-mapping means first access to a cold trie also pays page-fault cost.
2. **Integration.** The [`rescore`] module implements the ASR-specific
   rescoring stage described in `tmp/plan.md`: it generates correction
   candidates using acoustic confusion rules (voiced/unvoiced substitution,
   similar mora substitution, long vowel insertion/deletion, gemination
   insertion/deletion), scores them with a pluggable `CandidateScorer`, and
   re-ranks them. The default `LmScorer` normalizes hiragana to katakana
   before tokenizing, because the published model was trained on
   katakana/romaji data and raw hiragana token ids have zero counts in the
   tries.

   **Empirical finding (measured against the real model):** the LM *can*
   discriminate between hiragana ASR candidates when they are normalized to
   katakana before scoring. All three tested candidate pairs showed score
   differences of 3.5–5.1 nats. End-to-end rescoring of `おはよございます`
   correctly selects `おはようございます` (LM score diff 5.09 > confusion cost
   0.80). For gemination and voicing cases, the LM prefers the original
   hypothesis, so the overcorrection gate keeps it — conservative but correct.
   Raw hiragana (without katakana normalization) yields a uniform
   distribution and cannot discriminate; this is why the `LmScorer` always
   normalizes. The scoring interface is pluggable (`CandidateScorer` trait)
   so a better-suited LM can be dropped in if discrimination is insufficient
   for specific confusion patterns. See `examples/rescore_measure.rs` for
   the standalone measurement program.

   **Parameter sweep (`examples/rescore_sweep.rs`, against the real model):**
   on a fixed 14-case eval set (5 rule-covered repairs + 9 correct-form
   holds), the shipped defaults `lm_weight=1.0`, `confusion_weight=1.0`,
   `overcorrection_margin=0.0` score combined 9/14 (repairs 1/5, holds 8/9).
   The single overcorrected hold is the *correct geminated* `きってください`,
   which the default weights rewrite to `きてください` because the LM
   systematically prefers the shorter/bare form. Every combination with
   `overcorrection_margin >= 2.0` reclaims that hold and scores 10/14 without
   losing the one real repair (e.g. `lm_weight=0.5 conf_w=0.5 margin=2.0`).
   No combination fixes more than 1 repair, because the LM's discrimination is
   direction-biased: it only rewards *removing* length / moving toward the
   more-frequent form. Measured per-repair LM differences: `おはよございます`
   → `おはようございます` +5.09 (repairs), `せんせ` → `せんせい` −0.09,
   `おはよ` → `おはよう` −0.23, `がいしゃ` → `かいしゃ` −0.65, `がいとうした`
   → `かいとうした` +0.76 (the last clears its 1.0 voicing cost iff weights
   favor the LM enough). There is no weight where repairing the せんせ/おはよ
   short-phrase pairs becomes *possible* — the model genuinely scores the worn
   forms higher. Recommendation: raise `overcorrection_margin` to a positive
   value (>= 2.0) when wiring the rescorer in; keep the weights near 1.0/1.0.
   The defaults are *functional but not optimal* on this eval set.
3. **`lm_c_bc.marisa` is unused.** `Inference.swift` loads only four tries; the
   46 MB `c_bc` file is not among them. Worth understanding before shipping.
4. **Tokenizer portability.** The tokenizer reads the submodule's `vocab.json`
   and `merges.txt` at runtime. If this crate is ever published without the
   submodule, callers will need `from_dir` against their own copy or an
   embedded-loading variant; that is a deployment decision, not a code change.
   Also, `vocabSize` is still the upstream `// FIXME` constant 6000 (today
   correct; the loader already insists on exactly 6000 entries).

### Integration hazard

When this is eventually wired in, `azookey_input_text` must keep the **original
ASR reading**, not the corrected one. That field is the caption-merge key;
feeding it a corrected reading turns replace-in-place into append and
reintroduces the run-on captions fixed in `e393070`.
