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
- forwards signals, preserves the child exit status, and holds the lock until the child exits; and
- supports the emergency escape hatch `QUALITY_GATE_NO_LOCK=1`.

The actual check sequence remains in `package.json` as `check:all:unlocked`. The lock wrapper therefore cannot silently omit or reorder checks.

Implemented in commit `0acf5c0`.

### CI superset contract

`scripts/verify-ci-local-gates.mjs` verifies that `check:all:unlocked` contains a local equivalent of every classified CI gate across all jobs in `.github/workflows/ci.yml`. Local-only checks are allowed.

Direct Cargo commands in CI are mapped to named local scripts. Platform-specific exclusions are exact, must still exist in the workflow, and must include a non-empty reason. A new or unclassified CI gate fails the test instead of being silently ignored.

The audit found that CI built `packages/vibrato/wasm` for `wasm32-unknown-unknown --release`, while the local full gate did not. `rust:vibrato:wasm:build` now runs the identical non-mutating Cargo command locally. The required target is installed on the current machine.

Implemented in commit `40084bd`.

### Duplicate work removed

The second identical `assets:verify` invocation was removed without changing the set of checks.

Implemented in commit `2c604b8`.

## Memory incident and static findings

The measurements that triggered this work were taken under severe system pressure and are **not a performance baseline**:

- the always-on VM used about 16 GB;
- swap was approximately 31.65 GB of 32 GB used;
- load average was approximately 35; and
- Git and other small processes were killed with status 137.

This explains the observed Git failures and inflated gate duration. It also means those durations must not be used to claim an optimization benefit.

Static inspection of `packages/azookey-rust` found:

- 109 Rust tests in total;
- 47 explicit `test_system_dictionary_path()` call sites (36 in Viterbi tests, 5 dictionary, 4 accuracy corpus, 1 inventory, and 1 adversarial corpus);
- the accuracy tests cover 119 corpus cases, 47 exact conversions, and 30 filesystem/portable conversions;
- the adversarial corpus performs 303 conversions serially inside one test; and
- `SystemDictionary` owns `RefCell` caches and is not `Sync`.

Consequently, libtest's machine-default concurrency can keep multiple dictionaries and caches live at once, while it cannot shorten the longest 303-case serial test. This makes crate-specific test concurrency a plausible peak-memory control, but its effect must be measured in a healthy memory state.

## Prepared but not committed

`scripts/run-azookey-rust-test.mjs` and its unit test are prepared locally. The wrapper limits only the AzooKey crate:

- unset `RUST_TEST_THREADS`: use 2;
- positive integer: use the requested value; and
- `RUST_TEST_THREADS=default`: remove the variable and restore libtest's machine default.

It preserves the Cargo exit status and supplies the existing dictionary root. Do not commit the default of 2 until the benchmark below establishes its time/memory tradeoff.

The one-time timing runner `scripts/check-all.mjs` and its test are also local-only. They preserve the full ordered step list and exist solely to collect a clean baseline. Remove them after measurement unless the data justifies a permanent timing runner.

## Required measurements

Wait until other Rust builds, coverage runs, and model loads are stopped. Use `/usr/bin/time -l` so maximum resident set size includes descendants.

Measure `rust:azookey:test` sequentially with warm build artifacts:

1. `RUST_TEST_THREADS=default`
2. `RUST_TEST_THREADS=2`
3. `RUST_TEST_THREADS=1`

Record for every run:

- wall-clock time;
- child-tree maximum resident set size;
- exit status;
- whether compilation occurred and how long it took; and
- enough system memory context to reject a pressure-contaminated run.

Only adopt the default of 2 if it materially lowers peak RSS without an unacceptable wall-time regression. If the tradeoff is ambiguous, consult the advisor before committing.

Then run one clean `check:all` profile to obtain per-step elapsed time and peak RSS. This also validates commits `0acf5c0` and `40084bd` together. Do not run multiple full gates for measurement: the new mutex intentionally rejects overlap.

## Possible follow-ups

1. Add a configurable memory-pressure warning that prints the largest RSS consumers. Start with warning-only; a refusal threshold needs clean measurements and an override.
2. Measure `CARGO_BUILD_JOBS` values before limiting concurrent rustc processes. Do not apply a global setting without evidence.
3. Investigate sharing immutable AzooKey dictionary data separately from mutable caches. Converting `RefCell` caches to synchronized shared state is a production design change, not a development-tool quick fix.
4. Delete the local-only measurement scripts when the benchmark is complete.
