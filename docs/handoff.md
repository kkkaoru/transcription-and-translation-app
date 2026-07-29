# Viewing the work later and moving to another PC

All source and design notes are intentionally in this folder. Start with:

- `README.md` — product setup and OBS use
- `docs/architecture.md` — UI, overlay, native-output, and server boundaries
- `docs/inference-gateway.md` — Parapper/llama.cpp/Hy-MT2 runtime setup
- `docs/native-development.md` — platform prerequisites and verification
- `gateway/config.example.json` — non-secret gateway routing template

## Recommended handoff: Git remote

On the current machine, create a repository in a service you control (GitHub,
GitLab, Bitbucket, or an internal Git server), then run:

```bash
git init
git add .
git commit -m "Initial Caption Bridge MVP"
git branch -M main
git remote add origin <your-private-repository-url>
git push -u origin main
```

On another PC:

```bash
git clone <your-private-repository-url>
cd caption-bridge
pnpm install --frozen-lockfile
pnpm check:all
```

Do not commit downloaded GGUF/ONNX/BIN models, `gateway.config.json`, API keys,
or generated build output. The `.gitignore` already excludes models, local
toolchains, targets, coverage, and Node dependencies. Copy the model files by
your preferred secure method and create a new `gateway/gateway.config.json`
from the example on each machine.

## If Git hosting is not available yet

Archive the project directory without `node_modules`, `.tools`, `models`, and
build targets, transfer it securely, extract it on the next PC, then run the
same install and verification commands above. A Git remote remains the safer
way to preserve history and collaborate.
