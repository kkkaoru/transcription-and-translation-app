# caption-bridge-vibrato-wasm

This package is the small browser-facing Vibrato adapter used for feasibility
testing. It intentionally uses the heap-backed `vibrato` 0.5 dictionary reader
instead of `vibrato-rkyv`: `vibrato-rkyv` 0.7.8 cannot compile for
`wasm32-unknown-unknown` because its unconditional `fs4`/`rustix` dependency
requires an operating-system target (and its normal loading path uses
`memmap2`). See [`docs/vibrato-wasm.md`](../../docs/vibrato-wasm.md) for the
investigation and the UniDic memory budget.

The Rust/WASM API deliberately has no phrase table:

```ts
const tokenizer = await initTokenizer(dictionaryZstdBytes);
const tokens = tokenizer.tokenize("東京都に住む");
// [{ surface: "東京都", feature: "..." }, ...]
const reading = tokenizer.toHiragana("東京都に住む", 20); // UniDic CWJ
```

Workers that import the `.wasm` asset themselves can use
`initTokenizerFromModule(module, dictionaryZstdBytes)` from `lib/slim.ts`.

`dictionaryZstdBytes` is a zstd-compressed Vibrato `system.dic` model. The
`feature` field remains dictionary-dependent; UniDic CWJ's surface reading is
field 20 (`kana`), while IPADIC's reading is field 7. Keeping the complete
feature string avoids baking a dictionary-specific phrase list into the WASM.

## Build

The Rust target can be built without a WASI runtime:

```sh
cargo build --manifest-path packages/vibrato-wasm/Cargo.toml \
  --locked \
  --target wasm32-unknown-unknown --release
```

`node scripts/build-vibrato-wasm.mjs` performs that build and copies the raw
module to `packages/vibrato-wasm/pkg/`. Pass `--bindgen` (with the pinned
`wasm-bindgen` CLI available) to emit the JavaScript glue and TypeScript-friendly
entry points under `packages/vibrato-wasm/pkg-web/`; that mode also synchronizes
the generated JS/d.ts/WASM and dictionary/license copies into the comparison
app (the Worker receives only the raw module and attribution notices). If the
CLI is unavailable, the raw fallback is written only to
the ignored `packages/vibrato-wasm/pkg/` directory so a tracked bindgen package
cannot be replaced accidentally. The generated web package is checked in so
the TypeScript API remains usable after a clean clone.
