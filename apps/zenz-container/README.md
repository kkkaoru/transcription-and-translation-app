# Zenz GGUF Containers

Private Cloudflare Containers serving the reviewed Zenz v3.2 GGUF models to
`kotoba-beacon-inference` through a Worker service binding. The Container Worker
has no public `workers.dev` route.

## Images

One Dockerfile produces separate images with `image_vars.MODEL` so an instance
never carries the unused model:

| Container | Model SHA-256 | Local image size |
| --- | --- | ---: |
| `zenz-xsmall` | `00c64b3d318045a708d0cad5434faccab10f5481a49e6362864551fd0995fa58` | 31.9 MB |
| `zenz-small` | `29c223d4c23327b80fd13ebb5ab2555057a46317997d5da391584ffbef0db673` | 84.0 MB |

The image pins the reviewed AzooKey `llama.cpp` commit, verifies the GGUF hash,
links the runtime statically, strips symbols, disables OpenMP, and uses a pinned
distroless runtime.

## Lifecycle and sizing

Each model has one explicitly addressed instance with `max_instances: 1` and no
minimum instance count. Instances wake on demand and automatically scale to zero
after one idle minute. The Worker polls `/health` before forwarding completion
requests, so a request cannot race model loading.

Production uses `standard-3` (2 vCPU, 8 GiB memory, 16 GB disk). A production
benchmark showed that `basic` exceeded the 20-second completion budget and kept
the inference Worker near its 128 MB limit. `standard-3` completed the reviewed
pipeline in approximately 2.5–3.7 seconds while retaining scale-to-zero.

## Commands

```bash
# Bun is the package manager used by this repository.
bun install --frozen-lockfile
bun run typecheck
bun run deploy
```

Wrangler requires a Docker-compatible daemon for image rollout. Use
`--containers-rollout=none` only when updating Worker routing/lifecycle code
without changing the already-published images or instance configuration.
