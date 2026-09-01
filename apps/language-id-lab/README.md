# Language ID Lab

TanStack Start UI and private Cloudflare Container backend for realtime multilingual spoken-language identification.

## Runtime behavior

- `@ricky0123/vad-web` runs Silero VAD in the browser and emits 16 kHz mono voiced PCM.
- The input-level meter uses the live microphone waveform; the speech meter uses Silero probability.
- Voiced segments are sent to a session-sticky private Container. Audio is not stored and no transcript is produced.
- The Container runs the pinned `speechbrain/lang-id-voxlingua107-ecapa` ONNX export in native Rust and returns probabilities across all 107 model languages.
- Rust `language-harness-core` owns the Online HSMM, two-sided SPRT, and hysteresis state. The UI only renders returned diagnostics.
- **Per utterance** classifies each VAD segment independently. **Rolling 6 s context** retains voiced context across short segments before ECAPA inference.
- Basic (¼ vCPU, 1 GiB) and Standard (`standard-1`: ½ vCPU, 4 GiB) use the same model and Rust code.
- Stopping the microphone explicitly destroys the selected Container. Idle instances are destroyed after 30 seconds.

The interface is localized in Japanese and English. Language inference is not restricted to those UI locales.

## Cost data

`GET /api/container-usage` queries Cloudflare `containersUsageAdaptiveGroups`, the dashboard-aligned source for Container billing estimates. Configure a secret with **Account Analytics: Read**:

```sh
cd apps/language-id-lab
wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN
```

Without that secret, the UI states that live usage is unavailable while still showing published hourly rates. The usage figure is not an invoice: Workers, Durable Objects, logs, regional egress, negotiated pricing, and reporting delay can change the final charge.

Hourly rows distinguish provisioned memory+disk cost from the upper bound at 100% allocated CPU. Month-to-date overage applies the published Workers Paid Container inclusions before calculating the estimate.

## Model provenance

The Docker image downloads revision `41e60dea31b80ea5d4f9d9d9e818501ea184e568` of `drakulavich/SpeechBrain-coreml` and verifies SHA-256 for the ONNX graph, external weights, and 107 labels during the image build.

## Commands

From the repository root:

```sh
bun run language-id-lab:dev
bun run language-id-lab:typecheck
bun run language-id-lab:test:coverage
bun run language-id-lab:build
bun run rust:language-harness:fmt
bun run rust:language-harness:lint
bun run rust:language-harness:test
bun run language-id-lab:deploy
```

Run `bun run cf-typegen` from this directory after changing bindings. The Worker and both Container applications are configured in `wrangler.jsonc`.
