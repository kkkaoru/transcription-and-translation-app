# caption-bridge-input-lm

Rust port of azooKey's `EfficientNGram` — a Kneser-Ney smoothed, character-level
n-gram language model stored as MARISA tries.

## Status

**Phase 1 complete: the codec and the smoothing math, with no model file
required.** Reading real MARISA tries is not implemented yet; see
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
- Artifact: a single `input_n5_lm_v1.zip` (~120 MB) containing the MARISA tries
- License: Apache-2.0

No checksum is recorded here yet. The ZIP has not been downloaded, so there is
no measured SHA-256 to publish — do not fill one in without computing it.

azooKey ships this model with `n = 5`, `d = 0.75`, and a 6000-token vocabulary;
those are the values in `NgramParams::default()`.

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
[`MemoryTrie`] with no 120 MB download, and it is where a real MARISA reader
will plug in later.

## Tests

26 unit tests plus a doctest. Both the codec round-trips and the Kneser-Ney
probabilities are pinned, the latter against values computed by hand from the
Swift formula rather than from this implementation's own output.

Both breaks below were verified to fail the suite:

| Injected break | Tests that caught it |
| --- | --- |
| Predictive delimiter moved one digit right | 9 |
| Interpolation weight `gamma` halved | 3 |

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Remaining work

1. **Read real MARISA tries.** The format is non-trivial; expect either a C++
   FFI or a pure-Rust reader. Put it behind a Cargo feature that is off by
   default so the crate keeps building everywhere.
2. **Fetch and unpack the model** at the pinned revision, into a cache
   directory that is gitignored. Record the observed ZIP SHA-256 here then.
3. **Tokenizer.** `ZenzTokenizer` is a BPE tokenizer; its assets are vendored
   at `submodules/.../EfficientNGram/tokenizer/`. Note that upstream hardcodes
   `vocabSize = 6000` rather than reading it from the tokenizer, and that
   `start_token_id` here defaults to `0` — the real BOS id should be taken from
   `tokenizer_config.json` when the tokenizer lands.
4. **Integration.** Per `tmp/plan.md`, the intended use is re-scoring kana
   N-best candidates between ASR output and kana-kanji conversion. That stage
   does not exist yet and is out of scope for this crate.

### Integration hazard

When this is eventually wired in, `azookey_input_text` must keep the **original
ASR reading**, not the corrected one. That field is the caption-merge key;
feeding it a corrected reading turns replace-in-place into append and
reintroduces the run-on captions fixed in `e393070`.
