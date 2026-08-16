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

Live caption text after the max-iter fix **was measured** on 2026-08-16.
Plan 3 `convertAzookeyMessage` used local `kotoba-zenz-server` on
`zenz-v3.2-small` (`MODEL_ROUTES` pointed at `http://127.0.0.1:18082`).
Plan 1 used `convert_with_verifier_with_limit` with the embedded Candle
verifier. Both used `testdata/zenz_measured_completed.tsv` column
`artificial_left_context` as `leftContext` (not an empty string).
All 23 Plan 3 rows had `usedCompletion=true` and no `modelFallback`.

Exact Plan 1 vs Plan 3 text: **22/23**. The only split is
`measured-008`:

- input `せいかうりばはにかいです`
- leftContext `野菜と果物の売り場をご案内します。`
- expected `青果売り場は2階です`
- Plan 1 `青果売り場は2階です` (`Verified`)
- Plan 3 `青果売場は2階です`

Both miss expected on `measured-012` (`1230000円を売り上げました` vs
`123万円を売り上げました`) and `measured-020` (`記者が記者で` vs
`記者が汽車で`). Those are shared misses, not Plan 3-only splits.
Do not claim 23/23 identity.

**Do not read 22/23 as deployed quality.** That number is a local
`kotoba-zenz-server` measurement with `MODEL_ROUTES` pointed at loopback.
The hosted Worker measurement is in section 3.

The remaining live-path split is that one case: `measured-008`.
This is not the leftover search-shape gap (`candidate_path` / accumulated
constraints) and not the unconstrained-baseline origin gap that split
`measured-012`. The portable dictionary already contains both surfaces on
the same reading (`ウリバ` → `売場` / `売り場`). Plan 3's dictionary
baseline was already `生家売り場は2階です`, so the okurigana was present
before Zenz ran. The remote greedy completion (`temperature` 0) emitted
`青果売場は2階です`. Constrained search then followed that prefix: at
step 2 the prefix became `青果売場` and dropped `り`. Plan 3 binds the
lattice to one completion, so it cannot recover the longer surface.

Do not change this. It is one okurigana variant with the same meaning.
Fixing it would mean changing the one-HTTP-completion premise (sampling
or multiple completions), not widening the C ABI. The 2s wall budget
stays the limiter.

Not confirmed: which of `売場` and `売り場` is cheaper in the binary
dictionary. `probe_dict` was not run during the freeze that produced
this note.

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

Ready advertises a Zenz id only when that id is in `MODEL_ROUTES`.
An empty route map yields `models: [azookey-rust-wasm]` even if the
portable dictionary is loaded. A client that still sends an unadvertised
Zenz id gets dictionary text and `modelFallback=unconfigured-route`.
Compare hides unadvertised Zenz options on the worker path.

## 3. What production does now

Checked-in production config is empty, and the **deployed** Worker
matches it. Wrangler showed live `MODEL_ROUTES` as `{}` on 2026-08-16.

- `apps/cloudflare-worker-server/wrangler.jsonc:30` `"MODEL_ROUTES": "{}"`
- `.dev.vars.example:15` documents the same empty default
- `docs/cloudflare-worker-deployment.md:46` says empty routes keep
  optional chat routing disabled
- hosted inference Worker version `fb4a685c` (`workers_dev=false`)
- hosted compare Worker version `c1e711c0`
  (`https://azookey-compare.kaoru.workers.dev`, page chunk
  `page-c1894212ba983beb.js`)

Hosted wasm is the same file as this checkout:
`GET /azookey/azookey.wasm` sha256
`09483add2662102e2d70842f58593591b8eeea13df5007c71af70809ca51293a`
(396580 bytes) matches
`apps/cloudflare-worker-server/wasm/azookey.wasm`.

Hosted WS measurement on 2026-08-16
(`wss://azookey-compare.kaoru.workers.dev/ws/azookey`, model
`zenz-v3.2-small-gguf`, `leftContext` from the TSV column):

- 23/23 `modelFallback=unconfigured-route`
- 23/23 `usedCompletion=false`
- 23/23 `conversionStatus=0`
- every result `model=azookey-rust-wasm`, `requestedModel=zenz-v3.2-small-gguf`
- no `completionSkipReason` (skip is omitted when `modelFallback` is set)

Text identity on that hosted path:

| Comparison | Exact matches |
| --- | --- |
| Hosted Worker vs Plan 1 | **3/23** |
| Local Plan 3 (loopback Zenz) vs Plan 1 | **22/23** |

The three hosted matches are `measured-001`, `measured-012`, and
`measured-014`. Those are the rows where the dictionary baseline already
equals Plan 1. **3/23 is not a claim that the dictionary is 3/23 good.**
It is the count of rows where dictionary-only and Zenz already agree.
The other 20 rows are dictionary-only because production has no Zenz
route, not because Plan 3 search failed.

This empty default is intentional. The Worker README says production
stays dictionary-only until a GGUF upstream is configured, and not to
claim Plan 3 is browser-complete.

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
2. Change the live Worker `MODEL_ROUTES` to that host. The 2026-08-16
   deploy still has `{}`.
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
