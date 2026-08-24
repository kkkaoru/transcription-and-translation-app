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
