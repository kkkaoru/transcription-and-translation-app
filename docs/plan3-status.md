# Plan 3 status

This is the Worker / compare one-completion path. Plan 1 is desktop
in-process Zenz verification. This page records only what the code
currently does. It does not claim Plan 3 is Plan 1.

## 1. Remaining output differences versus Plan 1

The one success-path text difference that existed is closed.
`orchestrateOneCompletion` now returns the last constrained candidate
when the iteration cap is reached (`apps/cloudflare-worker-server/src/zenz-one-completion.ts:115-126`).
That matches Plan 1 `viterbi.rs:2089-2092`
(`ExhaustedWithConstrainedCandidate`).

These differences remain. They are not caption-text identity on a
successful Zenz path.

| Difference | Plan 1 | Plan 3 | Caption text |
| --- | --- | --- | --- |
| Constraint search | Accumulated constraints + `candidate_path` (`viterbi.rs:2054-2077`) | Current UTF-8 prefix only, `candidate_path: None` (`packages/azookey-wasm/src/lib.rs:366-375`) | Not reopened. A hint-on / hint-off experiment already produced the same text. |
| Unconstrained baseline origin | `convert_with_dictionary` | Dictionary convert is also `convert_with_dictionary`. Constrained search uses `build_lattice`. | Exact C ABI vs Rust spike was 22/23. The split is `measured-012` (`売り上げました` vs `売上ました`). Both miss the expected `123万円を売り上げました`. Do not claim 23/23. |
| VerificationState | 10 states (`verifier.rs:87-107`) | Not on the Worker result. Clients see `modelFallback`, `usedCompletion`, `completionSkipReason`. | Text is unchanged except the closed max-iter case. |
| Remote completion | Repeated verifier evaluate | One greedy `/completion` | By design. |

Whether those remaining search differences still change a live caption
after the max-iter fix is **not confirmed**. The 22/23 C ABI check was
taken before that fix, and it compared C ABI search to an in-Rust
spike, not desktop Plan 1 end-to-end.

## 2. When Plan 3 never reaches Zenz

`convertAzookeyMessage` (`apps/cloudflare-worker-server/src/azookey.ts:1598-1696`).

| Condition | Code | Returned text | Diagnostics |
| --- | --- | --- | --- |
| Requested model is `azookey-rust-wasm` | `:1598-1601` | Dictionary | `usedCompletion=false`. No skip reason. |
| Requested Zenz id is absent from `MODEL_ROUTES` | `:1602-1607` | Dictionary | `modelFallback=unconfigured-route`, `requestedModel=<id>` |
| `leftContext` is missing or trims to empty | `:1623-1626` | Dictionary | `completionSkipReason=empty-left-context` |
| `openLattice` is missing or returns nothing | `:1654-1657` | Dictionary after the HTTP completion is fetched | `completionSkipReason=lattice-unavailable` |
| HTTP `/completion` fails, times out, or returns empty | `:1675-1695` | Dictionary | `modelFallback=upstream-failed` |
| Constrained search is empty, throws, or the completion is a prefix of the candidate | `zenz-one-completion.ts:105-116` | Dictionary | `usedCompletion=true` |
| Compare `browser-vibrato` | `apps/azookey-compare/src/lib/conversion-pipeline.ts:222-250` | Browser Zenzai dictionary, not Worker WS | Worker diagnostics never appear |
| First compare utterance / no prior `done` row | `apps/azookey-compare/src/app/page.tsx:560-567` | Worker still runs; `leftContext=""` | Same as empty left context |

`maxIterations=0` exists only as an orchestration argument. Production
always uses `ZENZ_ONE_COMPLETION_MAX_ITERATIONS` (10).

Ready still advertises Zenz ids when the portable wasm dictionary is
loaded, even if `MODEL_ROUTES` is empty
(`azookey.ts:1873-1879`). A client that picks an advertised id then
hits `unconfigured-route`.

## 3. What production does now

Checked-in production config is empty:

- `apps/cloudflare-worker-server/wrangler.jsonc:30` `"MODEL_ROUTES": "{}"`
- `.dev.vars.example:15` documents the same empty default
- `docs/cloudflare-worker-deployment.md:46` says empty routes keep
  optional chat routing disabled

With that config, a Zenz request never calls `/completion`. It takes
the `unconfigured-route` branch and returns the portable-dictionary
text. Local probe on 2026-08-16 with `MODEL_ROUTES={}` produced
`modelFallback=unconfigured-route`, `usedCompletion=false`,
`conversionStatus=0`.

This empty default is intentional in the checked-in files. The Worker
README says production stays dictionary-only until a GGUF upstream is
configured, and not to claim Plan 3 is browser-complete.

Whether the **deployed** Worker still has `MODEL_ROUTES={}` is **not
confirmed from this checkout**. Wrangler vars can be overridden at
deploy time. This page does not inspect the live Worker.

Desktop Plan 1 does not read these Worker fields. It converts
in-process.

## 4. What is still required to turn Plan 3 on in production

Code that is already in the tree:

- one HTTP completion + constrained lattice search
- `leftContext` from compare UI (max 40 graphemes)
- lazy converter forwards `openLattice`
- max-iter returns the last constrained candidate
- `usedCompletion` / `completionSkipReason` / `conversionStatus`
  readable in compare

Not done, and required before production Zenz quality exists:

1. Set a non-empty production `MODEL_ROUTES` to an owned HTTPS
   `/completion` host for `zenz-v3.2-xsmall-gguf` and/or
   `zenz-v3.2-small-gguf`. The value is not in this repo.
2. Confirm the live Worker vars actually contain that route. The
   checked-in `{}` is not proof of the live value.
3. Confirm desktop Plan 1 quality first. The Worker README still says
   production routes stay empty until that confirmation.
4. Confirm a second-or-later compare utterance with a configured route
   shows `usedCompletion=true` in the compare trace. First utterances
   are expected to stay `empty-left-context`.

Not required to “turn Zenz on”, and still not claimed:

- C ABI 23/23 identity with Plan 1
- browser-complete Zenz GGUF
- emitting VerificationState on the Worker socket
- widening the C ABI with `candidate_path`
