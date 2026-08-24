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

## Worker audio metrics

`client-silero-v1` requests remain authoritative and bypass Worker VAD. For
other trusted ASR clients, the `worker-energy-v1` fallback now computes RMS
directly over each `Float32Array`, mutates bounded segment queues in place, and
finds trailing silence without copying/reversing the active queue. VAD timing,
thresholds, samples, and emitted PCM are unchanged.

Run its deterministic baseline/optimized fixture from the repository root:

```bash
bun run worker:metrics
```

A representative macOS ARM64 five-run median over 1,000,000 512-sample chunks
reduced fallback VAD wall time from 6,074 ms to 3,104 ms (49%) and CPU time from
6,123 ms to 3,086 ms (50%). It removes 2,000,000 temporary regular arrays and
512,000,000 copied sample values. Matching checksums and segmentation tests
protect output equivalence. This optimization does not change the normal
browser-segmented request path, but reduces CPU and allocation pressure for the
Worker-owned fallback.

## AzooKey metrics

Every completed AzooKey conversion emits privacy-safe `azookey_metrics` and
`speech_pipeline_metrics` records. Neither contains recognized text or prompts.
The AzooKey record
separates user-lexicon synchronization, system-dictionary conversion, lattice
open/uniqueness/search/close, Worker-to-Container HTTP, Container response-header
time, response-body transfer, llama.cpp prompt evaluation and token generation,
orchestration, and residual runtime overhead.
It also records the selected/effective model, fallback reason, token counts,
cache count, input sizes, and whether WASM was already warm.

Capture normalized production records and summarize averages/p50/p95/max:

```bash
bunx wrangler tail kotoba-beacon-inference --format json \
  | jq -rc '.logs[]?.message[]? | fromjson? | select(.event == "azookey_metrics" or .event == "speech_pipeline_metrics")' \
  > /tmp/azookey-metrics.jsonl
bun run worker:metrics:analyze /tmp/azookey-metrics.jsonl
```

The older per-phase `azookey_timing` logs remain available for live debugging;
`azookey_metrics` is the authoritative conversion record and
`speech_pipeline_metrics` is the authoritative outer-pipeline record. Replacing
the previous text-bearing pipeline log reduced the representative structured-log
payload from 765 bytes to 229 bytes on average (70%) while removing recognized
text from observability. Production
routes each compute/model/N5 profile through its own `PROFILE_CONVERTER`
Durable Object. That object retains the decompressed 24 MB system dictionary,
WASM instance, lattice state factory, and user-lexicon handle between requests,
then calls the selected Container from the same stable execution locus. Browser
warm-up primes both this object and the Container; Container release remains
independent and still scales every profile to zero. A separate
`zenz_container_metrics` record is emitted by the Container Worker for each
proxied request. In the current 30-conversion production sample, all requests
completed the authoritative GGUF path with no fallback. Internal GGUF conversion
averaged 363 ms (p50 305 ms). Parsing multipart input once reduced Nova-3 ASR
from the previous 389 ms average to 285 ms across 22 samples (p95 437 ms).
Whisper remained selectable for accuracy-sensitive audio and averaged 1,285 ms
across seven samples; it correctly retained the leading `お` in the greeting
fixture that Nova-3 omitted. The mixed-profile speculative AzooKey stage
averaged 774 ms. Eight repeated warm Standard XSmall/N5-on Nova-3 requests
averaged 660 ms for AzooKey and 1,546 ms end-to-end. The prior stateless-isolate
sample averaged 3,225 ms for successful GGUF calls and still fell back on two
of six requests. A direct
cross-script binding from the stateless inference Worker to the Container DO
was also tested; all six requests hit the GGUF timeout, so that topology was
reverted. A combined N5-plus-GGUF profile RPC was also tested and reverted: its
six-request AzooKey average rose from the 671 ms baseline to 831 ms and
end-to-end latency rose from 1,896 ms to 1,998 ms. Smart Placement was tested
through its analysis window and reverted as well: the eight-profile AzooKey
average rose from 862 ms to 1,297 ms and end-to-end latency from 1,646 ms to
2,313 ms. A one-thread Standard N5 llama configuration was also reverted after
its ten-request end-to-end average rose from 1,546 ms to 1,629 ms. A 64-token
Standard N5 batch produced a modest 621 ms AzooKey and 1,517 ms end-to-end
average, but was not retained because the subsequent all-profile deployment
could not validate Standard Small/N5-off while Cloudflare reported no available
Container instance. Anchoring the dictionary, N5 call, and GGUF call in the
profile DO without Smart Placement remains the successful topology.
The Container header duration intentionally ends when upstream
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
