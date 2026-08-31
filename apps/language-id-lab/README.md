# Language ID Lab

TanStack Start observability UI for the realtime multilingual language harness, deployed on Cloudflare Workers.

## Current milestone

The app provides:

- microphone selection and permission verification;
- stable language, candidate, and switch-evidence surfaces;
- acoustic, fused, and HMM posterior visualization;
- switch timeline and runtime diagnostics;
- deterministic synthetic scenarios for the PR's required JA ambiguity, JA → EN → JA, and unsupported-language behavior.

Synthetic scenarios are display fixtures, not a TypeScript implementation of the tracker. Rust remains the source of truth. Audio captured by the current UI is not uploaded; the LanguageSessionDO, Nova-3, and private Container bridges are subsequent PR phases.

## Commands

From the repository root:

```sh
bun run language-id-lab:dev
bun run language-id-lab:typecheck
bun run language-id-lab:test:coverage
bun run language-id-lab:build
bun run language-id-lab:deploy
```

The Cloudflare Worker is configured in `wrangler.jsonc`. Run `bun run cf-typegen` from this directory after adding bindings.
