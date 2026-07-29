# Bundled local model runtimes

Kotoba Beacon distributes two MIT-licensed `llama.cpp` server binaries:

- `kotoba-zenz-server` is built from the AzooKey `llama.cpp` fork at
  `88b97a47dc7f5892e2d5a6856fbe9cfe237f9e5c`. It provides the
  `gpt2-small-japanese-char` tokenizer required by zenz GGUF models.
- `kotoba-llama-server` is built from upstream `ggml-org/llama.cpp` at
  `caa596ab3f0f8768ee326d6e3d5d39782194676c`. It includes the STQ support
  required by Hy-MT2 GGUF models.

The verbatim MIT license is installed alongside this notice as
`llama.cpp-MIT.txt`. The app does not redistribute model weights. It downloads
only a model selected by the user to the app-data directory from the pinned
Hugging Face revision listed in `docs/llama-runtime.md`.

Model licenses remain with their publishers: zenz v3.2 artifacts are Apache-2.0,
zenz v2 is CC-BY-SA-4.0, and the Tencent Hy-MT2 artifacts are Apache-2.0.
