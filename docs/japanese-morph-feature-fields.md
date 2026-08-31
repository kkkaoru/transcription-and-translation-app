# Japanese morphological feature fields

Vibrato exposes IPADIC/UniDic token features as CSV-style text. Fields may
contain quoted commas, such as UniDic's `"B,B4WB7G9G"` value before the
surface-kana field. Do not use `split(',').nth(index)` to read these records:
it shifts every later index and previously changed `度`'s kana from `ド` to the
following `体` field.

Use the shared, allocation-free parser instead:

```rust
use caption_bridge_japanese_text::comma_separated_feature_field;

let kana = comma_separated_feature_field(feature, 20);
```

The parser scans UTF-8 bytes only up to the requested field, tracks quoted CSV
sections, and returns a slice of the original record. It performs no heap
allocation. Native and Tauri canonical-reading paths, plus Vibrato's IPADIC
lemma lookup, share this implementation so later feature fields cannot drift
independently.

## Benchmark

Run the checked-in release benchmark:

```bash
bun run rust:japanese-text:bench
```

Override its default 20 million iterations when profiling constrained hardware:

```bash
KOTOBA_FEATURE_BENCH_ITERATIONS=1000000 \
  bun run rust:japanese-text:bench
```

The benchmark first proves that the historical split parser returns `体` while
the CSV-aware parser returns `ド` for the real quoted UniDic row. It then emits
JSON lines for quoted canonical-kana extraction, plain canonical-kana
extraction, and the old plain split reference. Track `nanos_per_call`;
tokenization and ASR remain outside this microbenchmark.

A 2026-08-30 Apple Silicon release run measured 56 ns/call for the quoted row
and 73 ns/call for the plain row, including kana validation, versus 156 ns/call
for the old plain `split(',').nth(20)` reference. Treat these as comparative
local figures rather than a CI threshold. Even 20 morphological tokens add
about 1.5 microseconds, far below tokenizer and ASR latency.
