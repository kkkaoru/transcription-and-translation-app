# Cloudflare inference Worker

The hosted Next.js verification application uses one combined endpoint:

```text
POST /v1/speech/workers-ai/azookey
```

One browser-segmented WAV request is processed inside this Worker in order:

1. `@cf/deepgram/nova-3` or Whisper through the Workers AI binding.
2. Conditional Vibrato IPADIC reading extraction for kanji-bearing Japanese; pure kana passes through unchanged.
3. Optional `input_n5_lm_v1` ASR-confusion rescoring of that kana reading.
4. AzooKey lattice conversion with a length-bounded, prompt-cached Zenz GGUF completion.

The response contains `text`, `vibratoText`, `n5Text`, `convertedText`, `pipeline`, and structured `logs` entries. The same stage data is emitted as a `speech_pipeline` structured log for Workers Observability.

The browser does not execute ASR, Vibrato, morphology, or AzooKey. It only captures audio, uses Silero to create bounded utterances, sends WAV, and renders the returned JSON.

N5 and GGUF start speculatively in parallel. The speculative conversion is
accepted only when N5 leaves the reading unchanged; a corrected reading is
converted again. After the dictionary panel confirms that the Worker-owned
user lexicon is empty, the browser sends `userLexicon=off`, allowing inference
to skip the cold Durable Object metadata/snapshot RPC while retaining the
system dictionary. A non-empty lexicon automatically uses the revisioned RPC
path. Lattices with only one distinct output skip GGUF because the model cannot
select another valid candidate.

## Assets

- `wasm/vibrato_wasm_bg.wasm`
- `public/vibrato/system.dic.zst`
- `wasm/azookey.wasm`
- `public/azookey/system.azkdict.gz`

Both dictionaries are fetched through the Worker static-assets binding and cached per isolate. Production inference remains private (`workers_dev: false`) and is called by `azookey-compare` through a service binding.

## AzooKey metrics

Every completed AzooKey conversion emits one privacy-safe structured
`azookey_metrics` record. It contains no recognized text or prompt. The record
separates user-lexicon synchronization, system-dictionary conversion, lattice
open/uniqueness/search/close, Worker-to-Container HTTP, Container response-header
time, response-body transfer, llama.cpp prompt evaluation and token generation,
orchestration, and residual runtime overhead.
It also records the selected/effective model, fallback reason, token counts,
cache count, input sizes, and whether WASM was already warm.

Capture normalized production records and summarize averages/p50/p95/max:

```bash
bunx wrangler tail kotoba-beacon-inference --format json \
  | jq -rc '.logs[]?.message[]? | fromjson? | select(.event == "azookey_metrics")' \
  > /tmp/azookey-metrics.jsonl
bun run worker:metrics:analyze /tmp/azookey-metrics.jsonl
```

The older per-phase `azookey_timing` logs remain available for live debugging;
`azookey_metrics` is the authoritative per-request analysis record. A separate
`zenz_container_metrics` record is emitted by the Container Worker for each
proxied request. The Container header duration intentionally ends when upstream
headers arrive; `zenzBodyTransferMs` measures the remaining service-binding and
body-transfer time seen by inference.

## Validation

```bash
bun run typecheck
bun run test
bun run test:coverage
bunx biome check src
bun run deploy -- --dry-run
```

## Deployment order

```bash
cd apps/cloudflare-worker-server
bun run deploy

cd ../azookey-compare
bun run deploy
```

Deploy inference first so the compare Worker service binding always reaches the combined pipeline implementation.
