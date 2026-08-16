# Development quality gates

## Goal

The local full gate must complete within the memory available alongside the always-on development VM, without removing checks. A green local full gate must also cover every repository quality gate run by CI.

## Implemented safeguards

### Cross-worktree serialization

`bun run check:all` goes through `scripts/run-quality-gate-locked.mjs`. The wrapper:

- derives one lock key from the real Git common directory, so all worktrees of this repository contend for the same gate;
- atomically records the owner PID, OS process start time, command, working directory, and start timestamp;
- distinguishes a live owner using both PID and process start time, avoiding stale locks after PID reuse;
- safely reclaims dead owners only when the lock snapshot has not changed;
- exits with status 75 when another gate is active and explicitly states that checks were not run;
- records the unlocked gate's process-group ID in the lock, refuses to reclaim a dead wrapper's lock while that group survives, forwards signals to the full descendant tree, preserves the child exit status, and verifies that the group is empty before releasing the lock; and
- supports the emergency escape hatch `QUALITY_GATE_NO_LOCK=1`.

The actual check sequence remains in `package.json` as `check:all:unlocked`. The lock wrapper therefore cannot silently omit or reorder checks.

The original implementation in commit `0acf5c0` signaled only its direct Bun child. Stopping a gate demonstrated that the Node wrapper, Cargo process, and Rust test binary could become orphans while the lock was already free. The regression test now starts a child and grandchild, stops the wrapper's signal source, and verifies that every PID and the process group have disappeared before the wrapper returns.

### CI superset contract

`scripts/verify-ci-local-gates.mjs` verifies that `check:all:unlocked` contains a local equivalent of every classified CI gate across all jobs in `.github/workflows/ci.yml`. Local-only checks are allowed.

Direct Cargo commands in CI are mapped to named local scripts. Platform-specific exclusions are exact, must still exist in the workflow, and must include a non-empty reason. A new or unclassified CI gate fails the test instead of being silently ignored.

The audit found that CI built `packages/vibrato/wasm` for `wasm32-unknown-unknown --release`, while the local full gate did not. `rust:vibrato:wasm:build` now runs the identical non-mutating Cargo command locally. The required target is installed on the current machine.

Implemented in commit `40084bd`.

Coverage and typecheck also pin `package.json ⊆ CI ⊆ check:all` for those
suffixes. The source of truth is the `package.json` script name, not the
local step list, so a script that never joined either gate is still visible.
Each suffix is its own checker. Lint was classified on 2026-08-16 and is
**not** in this checker. Root `package.json` has nine `lint` / `*:lint`
scripts:

| Script | Class | Why |
| --- | --- | --- |
| `lint` | Gate | `biome check .`. In CI and `check:all`. |
| `parapper:lint` | Gate | Parapper ESLint. In both. |
| `parapper:rust:lint` | Gate | Parapper clippy. In both. CI clears `RUSTUP_TOOLCHAIN`. |
| `rust:azookey:lint` | Gate | In both. |
| `rust:input-lm:lint` | Gate | In both. |
| `rust:vibrato:lint` | Gate | In both. |
| `rust:wasm:lint` | Gate | In both. |
| `rust:lint` | Gate | Desktop clippy via `scripts/rust-lint.mjs`. Not an umbrella over the other Rust lints. In both. |
| `rust:zenz-verifier:lint` | Not class 2 | In `check:all`, not in CI. Already `--no-default-features`. The written local-only reason (`docs/development-quality-gates.md`, `packages/zenz-verifier-rust/README.md`) is for `rust:zenz-verifier:candle`, added in `9cb6089`. That commit put the Candle-free crate into `check:all` and never mentioned CI. There is no sentence that lint should stay off CI. |

Not in this family: package-local `lint` scripts (invoked by the root names),
`parapper:check` (umbrella), `rust:zenz-verifier:candle` (contains clippy,
name is not `:lint`), `format:check`.

Lint parity cannot start with an empty exclusion map. The only extra script
is `rust:zenz-verifier:lint`, and the honest text for it is "never added to
CI", which is drift, not an exclusion. Writing that into the map would make
the exclusion the product. Adding the script to CI is a separate decision.
Until one of those is chosen, do not add a lint checker. Fmt and test were
not re-classified here.

### Duplicate work removed, then restored as a post-build check

An earlier cleanup removed a second identical `assets:verify` from the local
gate because a Set comparison treated two invocations as one check. CI still
runs `assets:verify` twice in the quality job: once against the checkout, and
again after `worker:typecheck` regenerates the checked-in AzooKey WASM. The
local gate now keeps that second invocation so post-build bytes are verified.

`rust:zenz-verifier:candle` stays out of `check:all` on purpose. The default
verifier crate gate remains Candle-free so WASM-safe dependency boundaries stay
cheap to check. Desktop already compiles Candle through `rust:desktop:test`.
The all-features verifier unit/clippy run is a separate native-model gate and
must be invoked explicitly when GGUF or forward code changes.

`check:all:unlocked` runs `scripts/run-timed-quality-steps.mjs`, which prints a
monotonic start/end line for every step and writes `tmp/check-all-timing.json`.

## Memory incident and static findings

The measurements that triggered this work were taken under severe system pressure and are **not a performance baseline**:

- the always-on VM used about 16 GB;
- swap was approximately 31.65 GB of 32 GB used;
- load average was approximately 35; and
- Git and other small processes were killed with status 137.

This explains the observed Git failures and inflated gate duration. It also means those durations must not be used to claim an optimization benefit.

By 2026-08-14 22:07 UTC, before the controlled benchmark, the machine had recovered to a potential healthy baseline: `memory_pressure -Q` reported 76% system-wide memory free, swap usage was 0 MB, and the VM RSS was 8.71 GiB. A separate sentence-boundary test was still using about 875 MiB RSS and one CPU at that instant, so the AzooKey benchmark was correctly delayed until it exited. Record a fresh snapshot immediately before the benchmark; use the recovered values—not the earlier swap-exhausted values—as the comparison baseline.

Static inspection of `packages/azookey-rust` (2026-08-14, counts not
kept current) found that many tests each load the official dictionary,
the adversarial report is one serial test, and `SystemDictionary` owns
`RefCell` caches and is not `Sync`. Do not copy those counts forward;
`rust:azookey:test` and the corpus modules are the source of truth.

Consequently, libtest's machine-default concurrency can keep multiple dictionaries and caches live at once, while it cannot shorten the longest serial corpus test. This makes crate-specific test concurrency a plausible peak-memory control, but its effect must be measured in a healthy memory state.

## Benchmark isolation and healthy baseline

All agents work only in the shared `main` checkout. Creating branches or Git worktrees for measurement is prohibited. When a fixed source snapshot is required, export an unmanaged copy instead:

```bash
snapshot="$(git rev-parse HEAD)"
measure_dir="$(mktemp -d /tmp/kotoba-measure.XXXXXX)"
git archive "$snapshot" | tar -x -C "$measure_dir"
```

Run the benchmark from that directory, record `snapshot`, and delete the directory afterward. An archive has no Git metadata, cannot create a merge conflict, and is isolated from concurrent edits in the shared checkout. Its `target/` is also independent, so report compilation and test execution separately. Read-only assets such as the dictionary may be supplied with an absolute path to the main checkout when they are not under concurrent modification.

Use `/usr/bin/time -l` on macOS so maximum resident set size includes descendants. Record wall time, child-tree peak RSS, exit status, Cargo's compile time, libtest's runtime, and a memory-pressure snapshot.

The first valid healthy baseline was captured from exported-equivalent fixed commit `465277926a7e05bdb5df28cf2ee11f185a7bfbcb` on 2026-08-14:

| libtest threads | Tests | Wall time | Compile time | Test runtime | Peak child-tree RSS | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| machine default | 99 | 430.37 s | 1.21 s | 428.79 s | 284.9 MiB | pass |

The run started with 72% system-wide memory free, no swap, and no competing repository build or test. Compilation was 0.28% of wall time; the 428.79-second libtest execution is the optimization target.

Earlier shared-checkout exploratory runs reported 426.18 seconds at machine-default concurrency and 535.71 seconds with two threads, but a concurrent corpus edit made that comparison non-reproducible. Do not use the apparent 25.7% difference as a benchmark result. It still established that machine-default peak RSS is only about 285 MiB, which is not a meaningful constraint on this 48 GB host. The proposed thread limit was therefore not adopted, and the temporary thread wrapper was removed. Repeat concurrency measurements only if the test topology or memory profile changes materially.

## `rust:azookey:test` wall time

`bun run rust:azookey:test` is about 54 seconds on this machine
(2026-08-16: 54.2 s in `check:all`, 55.18 s when remeasured alone). That time
is the official-dictionary quality gate, not dictionary-open overhead. The
longest tests convert the locked 119-case accuracy anchor plus the 303-case
adversarial report. Do not drop those cases to make the gate faster.

Sharing the immutable official-system payload behind a test-only `OnceLock`
was measured on 2026-08-16. Each caller still owned empty lookup caches, so
one test could not warm or poison another. Wall time went from 55.18 s to
55.61 s (129 passed, 3 ignored). The change was reverted. The remaining wall
is lattice search on those corpora, already overlapped with loads by the
default libtest pool.

The three ignored tests are intentional manual benches
(`benchmark_privacy_safe_streaming_load`,
`benchmark_filesystem_dictionary_lookups`,
`benchmark_linear_lru_at_final_caption_frequency`). They are not forgotten CI
gaps.

Desktop `cargo test --lib` also reports 4 ignored. Those are intentional
Hugging Face downloads in `model_download` and `model_runtime`
(`downloads_xsmall_with_progress_callback`,
`batch_quick_start_downloads_missing_xsmall_and_skips_ready_hy`,
`cancel_aborts_in_flight_xsmall_download`,
`downloads_the_pinned_xsmall_model_into_app_data_layout`). Each pulls ~21 MiB
and is marked `run explicitly`. They are not forgotten CI gaps.

## Possible follow-ups

1. Add a configurable memory-pressure warning that prints the largest RSS consumers. Start with warning-only; a refusal threshold needs clean measurements and an override.
2. Measure `CARGO_BUILD_JOBS` values before limiting concurrent rustc processes. Do not apply a global setting without evidence.
3. Sharing immutable AzooKey dictionary data separately from mutable caches was already measured for the test gate (see above). Do not retry that test-only `OnceLock` unless the corpus shape changes. Converting production `RefCell` caches to synchronized shared state is still a production design change, not a development-tool quick fix.
4. Delete the local-only measurement scripts when the benchmark is complete.
