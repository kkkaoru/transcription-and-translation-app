# Privacy-safe streaming load corpus

Real-device diagnostics showed that short, independent conversion fixtures do
not represent live captions. The observed normalize-input distribution had a
32-character median, a 93-character 75th percentile, and a censored 90th
percentile near 158 characters. A turn produced two revisions at the median,
seven at p90, fourteen at p95, and up to twenty-four revisions.

Do not copy real speech from application logs into tests. The corpus below is
generated only from generic, hand-authored kana clauses and retains the measured
length and revision shapes without retaining a user's words.

## Deterministic source

Use Unicode-scalar counts, matching the Rust converter and the
`pipeline_stage` `input_chars` diagnostic. Concatenate the clauses without
punctuation to reproduce an ASR turn that has not yet emitted a sentence
boundary. Rotate the first clause by `seed`, repeat the sequence as necessary,
and take exactly `target_chars` scalars. Truncation may end inside a morpheme;
that is intentional because a streaming ASR revision commonly ends with an
incomplete word.

```rust
const SYNTHETIC_CLAUSES: &[&str] = &[
    "きょうのよていをかくにんしてつぎのさぎょうをはじめます",
    "しりょうのないようをみなおしてひつようなこうもくをせいりします",
    "じゅんばんをたしかめながらひとつずつけっかをきろくします",
    "せっていをほぞんしてからもういちどどうさをかくにんします",
    "さいごにぜんたいをみなおしてつぎのてじゅんをあんないします",
];

fn synthetic_prefix(seed: usize, target_chars: usize) -> String {
    SYNTHETIC_CLAUSES
        .iter()
        .cycle()
        .skip(seed % SYNTHETIC_CLAUSES.len())
        .flat_map(|clause| clause.chars())
        .take(target_chars)
        .collect()
}
```

These clauses are synthetic test language. They were not derived from the
contents of `kotoba-beacon.log`.

## Turn shapes

Each row is one turn. Every length in a row produces a revision of the same
turn, and each later input must start with the complete previous input.

| Case | Seed | Revision lengths (characters) | Purpose |
| --- | ---: | --- | --- |
| `synthetic-live-p50` | 0 | `16, 32` | p50 input and p50 revisions |
| `synthetic-live-p75` | 1 | `15, 29, 43, 57, 71, 84, 93` | p75 input and p90 revisions |
| `synthetic-live-p90` | 2 | `12, 23, 34, 46, 57, 68, 79, 91, 102, 113, 124, 136, 147, 158` | p90 input and p95 revisions |
| `synthetic-live-max-revisions` | 3 | `7, 14, 20, 27, 33, 40, 47, 53, 60, 66, 73, 79, 86, 93, 99, 106, 112, 119, 125, 132, 139, 145, 152, 158` | observed maximum of 24 revisions |
| `synthetic-live-long-growth` | 4 | `90, 117, 153, 240, 373, 409` | measured long-growth shape |

The set contains 53 conversion invocations. The long-growth row processes
1,382 source characters when every revision is converted from the beginning,
even though the final input contains only 409 characters. This is the workload
that an incremental implementation should reduce.

## Required checks

A test or benchmark consuming this corpus should verify all of the following:

1. Every generated input has exactly its declared Unicode-scalar length.
2. Revisions within one row are strictly increasing and append-only.
3. Conversion returns a non-empty candidate for every revision.
4. Timings are reported per invocation and cumulatively per turn.
5. Results identify the dictionary revision and conversion options.
6. Real speech, prompts, converted text, and model paths are not written into
   benchmark artifacts.

Do not add a fixed wall-clock CI threshold: host and build-profile differences
make one unreliable. Compare the same release binary and dictionary before and
after an optimization, report p50/p95/max and cumulative time, and use ratios
for regression review.
