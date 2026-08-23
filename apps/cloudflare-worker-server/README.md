# Cloudflare inference Worker

The hosted Next.js verification application uses one combined endpoint:

```text
POST /v1/speech/workers-ai/azookey
```

One browser-segmented WAV request is processed inside this Worker in order:

1. `@cf/deepgram/nova-3` through the Workers AI binding.
2. Vibrato IPADIC morphology/reading conversion through Worker-local WASM.
3. AzooKey kana-kanji correction through Worker-local WASM and the portable dictionary.

The response contains `text`, `vibratoText`, `convertedText`, `pipeline`, and three structured `logs` entries. The same stage data is emitted as a `speech_pipeline` structured log for Workers Observability.

The browser does not execute ASR, Vibrato, morphology, or AzooKey. It only captures audio, uses Silero to create bounded utterances, sends WAV, and renders the returned JSON.

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
