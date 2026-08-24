# Cloudflare speech pipeline verification UI

This Next.js application intentionally exposes one processing path only:

```text
Browser microphone
  -- audio/WAV --> azookey-compare Worker
  -- service binding --> kotoba-beacon-inference Worker
  -- @cf/deepgram/nova-3 --> Vibrato IPADIC WASM --> AzooKey WASM
  -- one JSON response --> Browser
```

The browser uses Silero VAD only to cut microphone audio into bounded utterances. It performs no ASR, morphology, reading conversion, or kana-kanji conversion.

## UI

- One microphone start/stop control.
- One D3.js pipeline visualization.
- One result card containing ASR, Vibrato, and AzooKey stage logs.
- A continuously updating Cloudflare cost estimate while capture is active.

The displayed cost is an estimate based on published list prices: Nova-3 HTTP audio minutes, Worker requests, and measured Worker-side Vibrato/AzooKey elapsed time. Cloudflare included usage and actual billed CPU can differ.

## Local verification

```bash
bun run worker:dev
bun run azookey-compare:dev
```

Then open `http://127.0.0.1:3000`. The combined route is:

```text
POST /v1/speech/workers-ai/azookey
```

## Browser audio metrics

The Silero hot path retains its 512-sample chunk, 576-sample model input,
64-sample context, recurrent state, and sample-rate typed arrays across model
runs. This mirrors the Native fixed-frame buffer policy without changing VAD
samples, state, threshold, or ONNX execution.

Run the deterministic baseline/optimized fixture from the repository root:

```bash
bun run web:metrics
```

A representative macOS ARM64 five-run median over 1,000,000 Silero chunks
reduced packing/state-update time from 559 ms to 201 ms (64%) and CPU time from
597 ms to 201 ms (66%). Hot-path typed array creation fell from 5,000,000 allocations / 5.64 GB of cumulative
allocation traffic to five allocations / 5.64 KB. These are cumulative bytes,
not retained RSS. Matching checksums and the real Silero ONNX test verify that
the samples and recurrent state remain unchanged.

## Quality checks

```bash
cd apps/azookey-compare
bun run typecheck
bun run lint
bun run test
bun run build:worker
```

## Deployment

Deploy inference first, then the UI Worker so the service binding always targets a compatible implementation:

```bash
cd apps/cloudflare-worker-server && bun run deploy
cd ../azookey-compare && bun run deploy
```

Production: <https://azookey-compare.kaoru.workers.dev/>
