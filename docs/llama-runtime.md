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

The 2-bit and 1.25-bit Hy-MT2 GGUFs are not in this catalog. On 2026-08-16 the
bundled `kotoba-llama-server` rejected both at load (`gguf_init_from_reader`
tensor offset mismatch on `blk.0.attn_k_norm.weight`). File sizes matched the
catalog. Offering them would download 600 MB or 461 MB and then fail readiness.

`hy-mt2-7b-gguf` stays selectable. It is a regular Q4_K_M GGUF and **does
load** on the bundled server. Measured 2026-08-16 with that same
`kotoba-llama-server`, `--ctx-size 4096 --parallel 1`, one server at a time,
and the desktop Japanese-to-English prompt (`今日の天気は晴れです。明日は雨が降るかもしれません。`):

| Model | Load | Translate wall | tok/s | Process RSS |
| --- | ---: | ---: | ---: | ---: |
| `hy-mt2-1.8b-gguf` (Q4_K_M) | 792 ms | 80–110 ms (n=3) | ~166 | **1.39 GiB** |
| `hy-mt2-7b-gguf` (Q4_K_M) | health after load | 424 ms (n=1) | 53.2 | **4.93 GiB** |

Download of the 4,624,648,896-byte 7B file took 374 s. **RSS 4.93 GiB is the
reason this row is a warning, not a default.** Machines that already run an
8–16 GiB VM will feel it. The 7B output on that prompt was `The weather today
is sunny. It might rain tomorrow.` (1.8B Q4: `The weather today is clear. It
might rain tomorrow.`).

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
