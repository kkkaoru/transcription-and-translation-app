# AzooKey quality verification

The Rust converter follows the same quality-oriented test shape used by the
official AzooKey converter.  The upstream reference is vendored as the
`submodules/AzooKeyKanaKanjiConverter` submodule; its `ConverterTests` cover
accuracy tables, verbal/contextual accuracy, gradual input, and meaning-based
homophone selection.

Our implementation keeps those checks independent from production custom
dictionaries:

- `packages/azookey-rust/src/kana_kanji/viterbi.rs` contains table-driven
  conversion regressions, prefix/gradual-input checks, deterministic N-best
  ordering, and idempotence checks using a temporary portable TSV fixture.
- The public-dictionary tests run against
  `submodules/azooKey_dictionary_storage` when
  `AZOOKEY_DICTIONARY_ROOT` is set.  They verify context-sensitive homophones,
  numeric conversion, unknown suffix preservation, and long-caption paths.
- `dictionary.rs` checks the upstream CID/MID class boundaries and terminal
  prediction-quality filter so a dictionary refresh cannot silently change
  the model metadata contract.

Run the focused suite with:

```sh
cargo test --manifest-path packages/azookey-rust/Cargo.toml --lib
AZOOKEY_DICTIONARY_ROOT="$PWD/submodules/azooKey_dictionary_storage/Dictionary" \
  cargo test --manifest-path packages/azookey-rust/Cargo.toml --lib
```

The root `bun run check:all` command includes these tests, Clippy with
`-D warnings`, and the 95% coverage gates for the TypeScript/Rust boundaries.
