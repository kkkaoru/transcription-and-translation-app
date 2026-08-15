# Bundled GGUF model runtime

Kotoba Beacon ships two local `llama-server` sidecars. This split is required:
the AzooKey fork understands zenz's `gpt2-small-japanese-char` tokenizer,
whereas current upstream llama.cpp supplies the STQ kernel needed by Hy-MT2.
Both listen only on `127.0.0.1`; the inference gateway is their only app-facing
HTTP route.

The application does not put GGUF weights in the installer. When a user chooses
a local model, Tauri downloads the exact reviewed Hugging Face revision to
`<app-data>/models/<model-id>/`, checks its final byte size, then atomically
installs it before starting the matching sidecar. An interrupted download is
discarded on the next attempt. This keeps first-run downloads, model licenses,
and disk usage explicit while leaving non-engineers with only one application to
start.

| Model ID | Sidecar | Source revision | File | Size |
| --- | --- | --- | --- | ---: |
| `zenz-v3.2-xsmall-gguf` | AzooKey fork | `Miwa-Keita/zenz-v3.2-xsmall-gguf@4f5423f` | `ggml-model-Q5_K_M.gguf` | 20.97 MB |
| `zenz-v3.2-small-gguf` | AzooKey fork | `Miwa-Keita/zenz-v3.2-small-gguf@c67e03e` | `ggml-model-Q5_K_M.gguf` | 73.87 MB |
| `zenz-v2-q5-k-m-gguf` | AzooKey fork | `Miwa-Keita/zenz-v2-gguf@a4b653d` | `zenz-v2-Q5_K_M.gguf` | 72.30 MB |
| `hy-mt2-1.8b-gguf` | upstream | `tencent/Hy-MT2-1.8B-GGUF@1cd5208` | `Hy-MT2-1.8B-Q4_K_M.gguf` | 1.13 GB |
| `hy-mt2-7b-gguf` | upstream | `tencent/Hy-MT2-7B-GGUF@ab84726` | `Hy-MT2-7B-Q4_K_M.gguf` | 4.62 GB |

The 2-bit and 1.25-bit Hy-MT2 GGUFs are not in this catalog. The bundled
`kotoba-llama-server` rejects those files at load (`gguf_init_from_reader`
tensor offset mismatch). Offering them would download hundreds of megabytes
and then fail readiness.

`kotoba-zenz-server` is built from
[`azooKey/llama.cpp@88b97a4`](https://github.com/azooKey/llama.cpp/tree/88b97a47dc7f5892e2d5a6856fbe9cfe237f9e5c).
`kotoba-llama-server` is built from
[`ggml-org/llama.cpp@caa596a`](https://github.com/ggml-org/llama.cpp/tree/caa596ab3f0f8768ee326d6e3d5d39782194676c).
Both are MIT licensed; the bundled copy is in
`apps/desktop/src-tauri/third-party/llama.cpp-MIT.txt`.

Model terms are separate from the runtime: zenz v3.2 is Apache-2.0,
zenz v2 is CC-BY-SA-4.0, and the Tencent Hy-MT2 GGUF repositories are
Apache-2.0. Review those upstream model cards before redistributing any cached
model files.
