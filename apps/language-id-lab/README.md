# Language ID Lab

TanStack Start UI with private Cloudflare Containers and Workers AI for realtime multilingual spoken-language identification.

## Runtime behavior

- `@ricky0123/vad-web` runs Silero VAD in the browser and emits 16 kHz mono voiced PCM.
- The input-level meter uses the live microphone waveform; the speech meter uses Silero probability.
- Select one method: SpeechBrain ECAPA or NVIDIA LangID AmberNet in an independent Basic/Standard Container, or Cloudflare Workers AI Deepgram Nova-3.
- Container methods return probabilities across all 107 model languages. Rust `language-harness-core` owns their Online HSMM, two-sided SPRT, and hysteresis state; the UI only renders returned diagnostics.
- Workers AI is stateless and returns Nova-3's provider language detection without duplicating the Rust tracker in TypeScript.
- **Per utterance** classifies each VAD segment independently. **Rolling 6 s context** retains voiced context across short segments for Container methods.
- Stopping the microphone explicitly destroys the selected Container. Idle instances are destroyed after 30 seconds.
- A D3.js timeline renders live raw evidence, stable posterior, and Rust enter/retain thresholds.

The interface is localized in Japanese and English. Language inference is not restricted to those UI locales.

## Translation and synthesized-voice check

The verification panel translates arbitrary text with Workers AI `@cf/meta/m2m100-1.2b`, synthesizes 16 kHz WAV with Fish Audio `s2.1-pro-free`, plays it, and submits that exact audio to the selected identification method. Configure Fish Audio only as a Worker secret:

```sh
cd apps/language-id-lab
wrangler secret put FISH_AUDIO_API_KEY
```

The secret is never returned to the browser. Without it, deployment and microphone identification still work, while the panel reports that synthesis is unavailable.

## Cost data

`GET /api/container-usage` queries Cloudflare `containersUsageAdaptiveGroups`, the dashboard-aligned source for Container billing estimates. Configure a secret with **Account Analytics: Read**:

```sh
cd apps/language-id-lab
wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN
```

Without that secret, the UI states that live usage is unavailable while still showing published hourly rates. The usage figure is not an invoice: Workers, Durable Objects, logs, regional egress, negotiated pricing, and reporting delay can change the final charge.

Hourly rows distinguish provisioned memory+disk cost from the upper bound at 100% allocated CPU. Month-to-date overage applies the published Workers Paid Container inclusions before calculating the estimate.

## Model provenance

The SpeechBrain image downloads revision `41e60dea31b80ea5d4f9d9d9e818501ea184e568` of `drakulavich/SpeechBrain-coreml` and verifies SHA-256 for the ONNX graph, external weights, and 107 labels.

The independent AmberNet image downloads NVIDIA NGC `ambernet.nemo` v1.12.0, verifies SHA-256 `2f92d645b9ea5824d7663584fecb9ecc52557d0d700e24266747f38a61ba1681`, and exports the official NeMo model to CPU ONNX during its build. Python is build-only; both final images run the same native Rust/ONNX Runtime service.

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

Run `bun run cf-typegen` from this directory after changing bindings. The Worker, Workers AI binding, and four model/tier Container applications are configured in `wrangler.jsonc`.
