# Zenz GGUF and Input N5 LM Containers

Private Cloudflare Containers serving the reviewed Zenz v3.2 GGUF models and
optional `input_n5_lm_v1` rescoring through the inference Worker service binding.
The Container Worker has no public `workers.dev` route.

## Profiles and optimized images

The browser explicitly selects this Cartesian product:

- compute: `basic` or `standard` (`standard` maps to Cloudflare `standard-3`)
- GGUF: XSmall or Small
- Input N5 LM: off or on

Eight separately addressed Container classes prevent one choice from waking a
different profile. Four image contents are produced by `image_vars.MODEL` and
`image_vars.N5_LM`. The following reproducible values come from `docker image
inspect --format '{{.Size}}'` for Linux/amd64:

| Image content | Previous | Optimized | Reduction |
| --- | ---: | ---: | ---: |
| XSmall, N5 off | 32,336,968 B | 23,714,238 B | 26.7% |
| Small, N5 off | 84,484,767 B | 75,862,031 B | 10.2% |
| XSmall, N5 on | 133,546,916 B | 125,257,471 B | 6.2% |
| Small, N5 on | 185,693,097 B | 177,405,295 B | 4.5% |

GGUF SHA-256 values:

- XSmall: `00c64b3d318045a708d0cad5434faccab10f5481a49e6362864551fd0995fa58`
- Small: `29c223d4c23327b80fd13ebb5ab2555057a46317997d5da391584ffbef0db673`
- Input N5 LM archive: `0aaf326140a92d577b2020905346672b8cc4c47e63516328add0f197568aaf7a`

The final image is `scratch` plus only the dynamic libraries reported by `ldd`.
It contains no shell, package manager, CA store, Web UI, or unrelated
Distroless files. N5-off images execute `llama-server` directly and do not
contain the Rust supervisor or N5 assets. GGUF and N5 files are copied as
separate final layers so unchanged model content can be reused by the registry.
The N5 image keeps only the four memory-mapped tries, `vocab.json`, and
`merges.txt`; the unused 46 MB trie, macOS archive metadata, and unrelated
tokenizer files are removed.

The build pins the AzooKey `llama.cpp` and repository revisions, verifies every
model hash, excludes the irrelevant ARM CPU backend from the amd64 binary,
strips both executables, uses Rust fat LTO with abort-on-panic, and disables the
embedded llama Web UI at build and runtime.

## Cold and warm execution

The Container Worker polls readiness every 100 ms instead of adding up to 500
ms between checks. Browser session warm-up now executes a one-token GGUF
completion and, when selected, an N5 rescore concurrently. This faults model
pages and primes tokenizer/model caches before the first committed utterance,
rather than merely checking an HTTP health route.

`llama-server` uses mmap for faster startup. Basic uses a 256-token context,
256-token batch/ubatch, and one thread. Standard uses the same bounded 256-token
context and batch with two threads on the two-vCPU `standard-3` profile. Both
disable the Web UI and use one parallel slot. The Worker bounds GGUF
generation from the corrected reading length instead of always decoding 64
tokens. Both tiers request only an 8–16 token GGUF prefix; the full-length
AzooKey lattice remains authoritative and either completes the constrained
candidate or safely retains its dictionary baseline. The live path gives GGUF
3.5 seconds; if it misses that bound, the already-computed official AzooKey
lattice result is returned with explicit
`modelFallback` metadata rather than allowing Container latency to block captions.

The optimized N5 build was exercised under Linux/amd64 QEMU. It corrected
`おはよございます` to `おはようございます`; four successive model timings were
306.2, 286.8, 281.2, and 285.3 ms at about 144.8 MiB RSS. Native Cloudflare
amd64 measurements remain authoritative because local GGUF execution under
macOS ARM64 emulation is not representative.

The Japanese accuracy path is `ASR surface → conditional Vibrato kana reading
→ input_n5_lm_v1 ASR rescore → AzooKey lattice/GGUF`. Pure kana bypasses
morphological rewriting, while kanji-bearing ASR text is converted to a kana
reading before N5. This prevents particles in pure kana from being changed and
prevents the kana-oriented N5 model from receiving kanji.

Final production validation returned HTTP 200 for all eight profiles. Browser
capture starts the warm-up before the first utterance, so the cold Container
load is normally hidden. Production N5 rescoring remained roughly 90–140 ms.

An AVX2/FMA runtime-dispatch build and 1–4-token staged generation were also
production-tested. AVX2 did not produce a consistent latency reduction across
Container placements and increased every image. Staged generation reached a
fast first prefix, but ambiguous lattices then required a second full decode
and were slower or hit the live timeout. Both experiments were reverted; the
portable binary and single bounded completion remain the accuracy-preserving
production configuration.

## Lifecycle and sizing

Every profile has `max_instances: 1` and no minimum. Browser stop sends an
explicit `DELETE` release through compare → inference → Container Worker, which
calls `destroy()`. Browser disposal/unload uses a keepalive release request so
navigation does not cancel cleanup. `onActivityExpired()` also calls
`destroy()` after 30 idle seconds if the browser disappears or networking
fails. Cloudflare's documented lifecycle then removes the ephemeral instance;
no code path intentionally renews an idle Container. Production verification
must confirm all eight instances become `inactive` or `stopped` after rollout
and benchmark requests.

`basic` uses 0.25 vCPU, 1 GiB memory, 4 GB disk, and an 8–16 token completion
budget. `standard` maps to `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk) and
uses the same bounded 8–16 token GGUF prefix budget. Deferring Worker dictionary
materialization until a basic completion returns prevents the 128 MB inference
isolate limit from being exceeded.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run deploy
```

Wrangler requires a Docker-compatible daemon for image rollout. Use
`--containers-rollout=none` only for Worker routing or lifecycle changes that
do not alter image contents, entrypoint arguments, or instance types.
