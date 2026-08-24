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
256-token batch/ubatch, and one thread. Standard uses a 1024-token context,
512-token batch/ubatch, and two threads. Both disable the Web UI and use one
parallel slot. The smaller bounded batches reduce allocation and startup work
without reducing the existing completion budget.

The optimized N5 build was exercised under Linux/amd64 QEMU. It corrected
`おはよございます` to `おはようございます`; four successive model timings were
306.2, 286.8, 281.2, and 285.3 ms at about 144.8 MiB RSS. Native Cloudflare
amd64 measurements remain authoritative because local GGUF execution under
macOS ARM64 emulation is not representative.

A production cold/warm pair for each of the eight profiles averaged 7,193.5 ms
cold and 5,053.0 ms warm end-to-end. The AzooKey stage averaged 4,818.5 ms cold
and 3,685.5 ms warm. Individual requests vary with Workers AI and placement;
the paired run showed the intended warm improvement in seven profiles, while
one Basic XSmall request was slower due to runtime variance. Production N5
rescoring remained bounded at roughly 89–145 ms cold and 89–130 ms warm.

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
uses the full 64-token completion budget. Deferring Worker dictionary
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
