# Zenz GGUF and Input N5 LM Containers

Private Cloudflare Containers serving the reviewed Zenz v3.2 GGUF models and
optional `input_n5_lm_v1` rescoring through the inference Worker service binding.
The Container Worker has no public `workers.dev` route.

## Profiles and images

The browser explicitly selects this Cartesian product:

- compute: `basic` or `standard` (`standard` maps to Cloudflare `standard-3`)
- GGUF: XSmall or Small
- Input N5 LM: off or on

Eight separately addressed Container classes prevent one choice from waking a
different profile. Four deduplicated image contents are produced by
`image_vars.MODEL` and `image_vars.N5_LM`:

| Image content | Local amd64 size |
| --- | ---: |
| XSmall, N5 off | 32.3 MB |
| Small, N5 off | 84.5 MB |
| XSmall, N5 on | 133.5 MB |
| Small, N5 on | 185.7 MB |

GGUF SHA-256 values:

- XSmall: `00c64b3d318045a708d0cad5434faccab10f5481a49e6362864551fd0995fa58`
- Small: `29c223d4c23327b80fd13ebb5ab2555057a46317997d5da391584ffbef0db673`
- Input N5 LM archive: `0aaf326140a92d577b2020905346672b8cc4c47e63516328add0f197568aaf7a`

The build pins the AzooKey `llama.cpp` and repository revisions, verifies every
model hash, removes the unused 46 MB N5 trie, statically links and strips
`llama-server`, strips the Rust N5 server, and uses a pinned distroless runtime.

## Lifecycle and sizing

Every profile has `max_instances: 1` and no minimum. Browser stop/unmount sends
an explicit `DELETE` release through compare → inference → Container Worker,
which calls `destroy()`. `onActivityExpired()` also calls `destroy()` after one
idle minute if a browser disappears or networking fails. Production verification
confirmed all eight instances become `inactive` or `stopped` after release.

`basic` uses 0.25 vCPU, 1 GiB memory, 4 GB disk, one llama thread, a 256-token
context, and an 8–16 token completion budget. `standard` maps to `standard-3`
(2 vCPU, 8 GiB memory, 16 GB disk), two threads, a 1024-token context, and the
full 64-token completion budget. Deferring Worker dictionary materialization
until a basic completion returns prevents the 128 MB inference-isolate limit
from being exceeded.

The N5 server memory-maps the four required tries and reports model-only
`elapsedMs` separately from request round-trip time. Local amd64 emulation
measured about 145.8 MiB RSS after rescoring; the model corrected
`おはよございます` to `おはようございます` in 336.8 ms under QEMU.

## Commands

```bash
bun install --frozen-lockfile
bun run typecheck
bun run deploy
```

Wrangler requires a Docker-compatible daemon for image rollout. Use
`--containers-rollout=none` only for Worker routing, lifecycle, or entrypoint
argument changes that do not alter published image contents or instance types.
