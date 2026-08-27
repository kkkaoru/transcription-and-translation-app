# Zenz GGUF and Input N5 LM Containers

Private Cloudflare Containers serving the reviewed Zenz v3.2 GGUF models and
optional `input_n5_lm_v1` rescoring through the inference Worker service binding.
The Container Worker has no public `workers.dev` route.

The complete CRIU, Workers Cache, native snapshot, and future snapshot
acceptance report is in
[`docs/cloudflare-container-checkpoint-evaluation.md`](docs/cloudflare-container-checkpoint-evaluation.md).

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
ms between checks. `llama-server` starts with `--no-warmup`, so a health probe
or unused short session does not pay for llama.cpp's implicit empty inference.
Browser session warm-up remains an explicit opt-in: it executes a one-token
GGUF completion and, when selected, an N5 rescore concurrently. This faults
model pages and primes tokenizer/model caches only when a capture session has
signaled that it will use inference.

The measured `basic/xsmall/n5-off` profile uses `--no-mmap`; five paired
Cloudflare cold runs reduced median readiness from 1,089 to 775 ms and median
readiness plus first completion from 1,175 to 825 ms. Its median first
completion fell from 80 to 50 ms. Other profiles retain mmap until they are
measured independently. Basic uses a 256-token context, 256-token batch/ubatch,
and one thread. Standard uses the same bounded 256-token
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

The proxy emits `zenz_container_metrics` and returns an
`x-kotoba-container-headers-ms` diagnostic header. It forwards the requested
operation directly because `Container.fetch()` already starts the instance and
waits for configured ports; the former unconditional `/health` request added a
second Durable Object proxy operation to every hot completion.

## Lifecycle and sizing

Every profile has `max_instances: 1` and no minimum. This intentionally avoids
sharding: one bounded instance per explicitly selected profile is the lowest
cost design, and more shards would multiply model memory, cold starts, and idle
billing without measured queue pressure. Request routing resolves only the
selected Durable Object binding rather than constructing stubs for all eight
profiles. Browser stop sends an explicit `DELETE` release through compare →
inference → Container Worker, which calls `destroy()`. Browser disposal/unload
uses a keepalive release request so navigation does not cancel cleanup.
`onActivityExpired()` also calls `destroy()` after 30 idle seconds if the
browser disappears or networking fails. Cloudflare's documented lifecycle then
removes the ephemeral instance; no code path intentionally renews an idle
Container. Production verification must confirm all eight instances become
`inactive` or `stopped` after rollout and benchmark requests.

Production Container process checkpoints are deliberately not copied to R2;
the isolated probe below is the only exception. Managed Cloudflare Containers
do not document user-controlled CRIU capabilities or
checkpoint/restore. Their documented whole-container/directory snapshots are
not generally available yet. Experimental `workerd` runtime types contain
`snapshotContainer()` and snapshot restore shapes, but the public Container
class documentation does not expose them and the FAQ still says snapshots are
coming soon. The isolated 2026-08-27 remote probe below confirmed that the
methods exist but reject both whole-container and directory snapshots for this
Container with a prerequisite error. The open-source local-Docker implementation
creates a snapshot with Docker's paused `/commit` API and restores it as an
image, so it preserves
the root filesystem rather than live process memory, threads, or sockets. R2
FUSE likewise persists files, not process memory, and is slower than native
SSD storage; putting the immutable mmap-backed GGUF there would add
transfer and page-fault cost compared with the image layer. Workers Cache can
cache HTTP objects but cannot restore a Linux process or its memory mappings.
Do not adopt checkpoint restoration in production until repeated measurements
show lower cold-ready latency, first-completion latency, billed runtime, and
failure rate than the current image-layer cold start.

### Isolated native snapshot and Cache probe

`wrangler.snapshot.jsonc` deploys a separate workers.dev-only Worker, Durable
Object class, and xsmall `basic` Container. `POST /run` is protected by the
`SNAPSHOT_DIAGNOSTIC_TOKEN` secret. It starts and completes a llama request,
attempts both `snapshotContainer()` and `snapshotDirectory()`, round-trips a
snapshot-shaped metadata response through a named Cloudflare Cache, persists
the report in Durable Object storage, and destroys the Container in `finally`.
Authenticated `GET /last` returns the report without starting a Container.

The 2026-08-27 remote result was:

```text
initial xsmall ready: 652 ms (a prior cold sample was 1356 ms)
Cloudflare Cache metadata put: 4 ms
Cloudflare Cache metadata match: 4 ms
snapshotContainer: Snapshots are not available because the container does not meet the required snapshot prerequisites.
snapshotDirectory: Snapshots are not available because the container does not meet the required snapshot prerequisites.
```

The Cache round-trip succeeded in the same data center, but no real snapshot
handle or snapshot payload could be cached because Cloudflare rejected snapshot
creation. The Cache API stores HTTP `Response` objects, is not replicated to
other data centers, and is not durable snapshot storage. Therefore no snapshot
restore timing exists and this probe provides no evidence of a faster Container
start. Re-run the isolated probe only after Cloudflare documents native
Container snapshot prerequisites or enables the feature for the account.

### Isolated CRIU capability probe

`wrangler.criu.jsonc` defines a separate workers.dev-only Worker, Durable Object
class, R2 bucket, and `basic` Container image. It does not change or route
traffic to any production Container class. The image builds the security-fixed
CRIU 4.2.1 source release after verifying its SHA-256 and includes only the
xsmall llama.cpp profile needed by the restore probe. `POST /run` requires the
`CRIU_DIAGNOSTIC_TOKEN` secret, starts one diagnostic instance, streams the
checkpoint from R2, verifies its SHA-256, restores it, runs health and completion
checks, records the report in Durable Object storage, and destroys the instance
in `finally`. Authenticated `GET /last` retrieves that report without starting
a Container. The PoC has `max_instances: 1`, no minimum, no runtime Internet
access, and the same 30-second inactivity fallback.

Create the isolated bucket once, upload the pinned fixture, and run the probe:

```bash
bunx wrangler r2 bucket create kotoba-beacon-zenz-criu-poc
bunx wrangler r2 object put \
  kotoba-beacon-zenz-criu-poc/checkpoints/llama-xsmall-amd64-criu-4.2.1.tar.gz \
  --file criu-poc/llama-xsmall-amd64.tar.gz \
  --content-type application/gzip --remote
bunx wrangler secret put CRIU_DIAGNOSTIC_TOKEN --config wrangler.criu.jsonc
bunx wrangler deploy --config wrangler.criu.jsonc
curl -fsS -X POST \
  -H "Authorization: Bearer $CRIU_DIAGNOSTIC_TOKEN" \
  https://kotoba-beacon-zenz-criu-poc.<account-subdomain>.workers.dev/run
curl -fsS \
  -H "Authorization: Bearer $CRIU_DIAGNOSTIC_TOKEN" \
  https://kotoba-beacon-zenz-criu-poc.<account-subdomain>.workers.dev/last
```

The 2026-08-27 Cloudflare probe produced two distinct results:

- Dumping inside Cloudflare is unavailable. `criu check --all` cannot access
  `/proc/sys/kernel/ns_last_pid`, and even an isolated `/bin/sleep` dump fails
  because the Cloudflare kernel returns `ENOSYS` for `kcmp()`.
- Restore-only from an externally generated checkpoint works. The kernel
  supports `clone3(set_tid)`, and both `/bin/sleep` and a warmed xsmall
  llama-server were restored from R2.

The llama checkpoint is generated in a true x86_64 QEMU VM from the exact
binary, model, library, arguments, and CRIU version used by the diagnostic
image. Both dump and restore use `setarch x86_64 -R` so the PIE memory layout is
stable. The diagnostic CRIU applies `criu-poc/pr-set-mm-order.patch` to make its
legacy `PR_SET_MM` fallback set upper bounds before lower bounds when the
Cloudflare kernel rejects atomic `PR_SET_MM_MAP`.

The final R2 artifact and observed result were:

```text
key: checkpoints/llama-xsmall-amd64-criu-4.2.1.tar.gz
compressed size: approximately 1.1 MiB
sha256: 03b99a129b5e64ecf61b78c99bfab081092c120db411141ecdb7d797d9aa9537
restored pid: 2000
restored /health: HTTP 200
restored /completion: HTTP 200
end-to-end diagnostic elapsedMs: 2272
```

The GGUF remains an mmap-backed file in the Container image and is not copied
into the CRIU archive. The 2.272-second measurement includes Container start,
R2 transfer, extraction, restore, health/completion validation, and the other
diagnostic checks; it is not a standalone restore benchmark or a comparison
against a normal cold start. Restore currently uses `--cpu-cap=none`, so a
production implementation must validate the snapshot identity and CPU feature
set before restore. Adoption remains gated on repeated cold-start benchmarks
and removal or acceptance of the small CRIU maintenance patch. The full report
remains in the diagnostic Durable Object and is available through authenticated
`GET /last`.

### CRIU archive delivery through Workers Cache

`wrangler.criu-cache.jsonc` tests the complete delivery path used by the
Cloudflare Tech World design rather than caching only snapshot metadata:

```text
Container -> virtual HTTP host -> co-located outbound Worker
          -> named Workers Cache -> R2 on cache miss
```

The Container has public Internet access disabled. Its request to
`http://checkpoint.r2` is intercepted by `ContainerProxy`; the outbound handler
reads the private R2 binding on a miss, stores a cloned HTTP response in Workers
Cache, and returns the cached archive on subsequent requests. A random query
key guarantees that every benchmark begins with an R2 miss. The test destroys
and restarts the Container, verifies `MISS` followed by `HIT`, checks the
archive byte count and pinned SHA-256, restores llama-server, and requires HTTP
200 from both health and completion after each restore. The historical timing
run used a functionally equivalent 1,076,203-byte checkpoint; current reruns use
the repository fixture documented in the detailed report.

Three miss runs and five hit runs measured:

```text
median R2-miss archive download:     231.160 ms
median Workers Cache-hit download:    35.077 ms
median download reduction:             84.8%
median miss restore pipeline:         953 ms
median hit restore pipeline:          826 ms
median restore-pipeline reduction:     13.3%
```

Workers Cache clearly accelerates checkpoint delivery, but it did not
consistently reduce end-to-end readiness. Container allocation varied from
239 ms to 16,432 ms and dominated some samples. In one separate-request cache
hit, start plus verified restore took 1,310 ms; another took 7,020 ms because
allocation alone took 6,254 ms. Workers Cache is data-center-local, evictable,
and not replicated, so R2 remains the source of truth and every start must
support a cache miss. Treat the cache as a transfer optimization, not as the
snapshot store or a guarantee of faster Container allocation.

### Final xsmall cold-path selection

A common checkpoint was also embedded, already extracted, in a minimal 30 MB
Container image and restored directly from its entrypoint. Public Worker →
Container health and completion both succeeded, but paired Cloudflare cold
runs showed that CRIU was not the fastest end-to-end path. A second CRIU image
capturing the model with `--no-mmap` reduced first-completion page faults but
increased restore readiness enough to remain slower overall.

Five alternating, fresh-Durable-Object runs selected ordinary llama startup
with `--no-mmap` for `basic/xsmall/n5-off`:

```text
                                mmap     --no-mmap   reduction
median ready                    1089 ms      775 ms      314 ms
median first completion           80 ms       50 ms       30 ms
median ready + first completion 1175 ms      825 ms      350 ms (29.8%)
maximum ready + first completion 1302 ms     1116 ms      186 ms
```

The mmap-backed baked-CRIU path measured a 1,245 ms median and 2,806 ms maximum
for ready plus first completion, so it remains diagnostic-only.

A second reconsideration tested the real UI default shape, xsmall on
`standard-3` with two llama threads. Ten alternating Cloudflare trials compared
normal mmap, normal `--no-mmap`, and a warmed image-baked CRIU checkpoint. Ten
more compared the same normal paths with a smaller checkpoint captured as soon
as health became ready:

```text
                                      ready p50  first p50  total p50  total p95
normal mmap, warmed-checkpoint run        501 ms       15 ms     524 ms    2230 ms
normal --no-mmap, same run                542 ms       15 ms     560 ms     939 ms
warmed CRIU                               521 ms       69 ms     556 ms     943 ms
normal mmap, ready-checkpoint run         532 ms       20 ms     554 ms    1550 ms
normal --no-mmap, same run                526 ms        7 ms     542 ms    1095 ms
ready-only CRIU                           516 ms       74 ms     623 ms    1600 ms
```

Removing warm state reduced the checkpoint from about 1.3 MiB to 809 KiB but
did not remove CRIU's first-completion penalty. The warmed CRIU path was 32 ms
slower than matched normal startup at p50; ready-only CRIU was 69 ms slower.
The warmed path's lower tail than mmap was reproduced by ordinary `--no-mmap`
without CRIU, so it is not evidence that process restoration improves
allocation variance. Across the 20 normal samples, mmap retained the lower
combined p50 (543 versus 547 ms), and production standard remains unchanged.

The remaining plausible CRIU target was the N5-on supervisor process tree. An
exact two-process checkpoint restored llama health/completion and N5
health/rescore successfully, but its archive was 97 MiB and expanded to 144 MiB
because the parsed N5 tokenizer and scorer are anonymous memory rather than
file-backed mappings. Five alternating true-x86 QEMU runs failed the
pre-deployment performance gate:

```text
                              ready p50  concurrent inference p50  total p50
normal N5-on                      3035 ms                     752 ms    3787 ms
baked process-tree CRIU           3371 ms                     825 ms    3992 ms
```

CRIU was 205 ms (5.4%) slower overall before Cloudflare deployment, while also
adding 97 MiB of checkpoint payload. That variant was therefore removed rather
than spending a Cloudflare rollout on a locally inferior candidate.

CRIU's retained role is a restore-capability and kernel-regression canary, not a
production startup path or fallback. Reconsider it only for a future workload
whose avoidable user-space initialization is substantially larger, whose
anonymous checkpoint state stays small, and whose exact target-profile matched
Cloudflare trials improve p50, p95, first useful inference, billed runtime, and
failure rate. Small-model, N5, and other production profiles retain their
existing mmap setting until they independently pass those gates.

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
