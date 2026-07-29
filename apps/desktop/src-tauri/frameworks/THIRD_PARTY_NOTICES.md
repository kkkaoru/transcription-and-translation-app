# Bundled macOS framework notices

## Syphon.framework 5

Kotoba Beacon bundles Syphon.framework 5, obtained from the official Syphon SDK
release: https://github.com/Syphon/Syphon-Framework/releases/tag/5

Syphon.framework is licensed under the BSD 3-Clause License. The source and
license text are available at: https://github.com/Syphon/Syphon-Framework

## Parapper-ASR headless runtime

Kotoba Beacon embeds a source fork of Parakeet-Inc/Parapper-ASR as its local
Japanese recognition sidecar. Parapper-ASR is MIT licensed; its verbatim
license, fork notice, and generated Rust dependency license inventory are
installed in the app resources under `third-party/` at bundle time. Model
artifacts are downloaded at first use and are not redistributed by this
repository; their separate license terms remain applicable.

## llama.cpp model servers

Kotoba Beacon bundles an AzooKey `llama.cpp` fork for zenz tokenizer support
and current upstream `ggml-org/llama.cpp` for Hy-MT2 STQ support. Both server
sources are MIT licensed. The bundle includes the verbatim MIT license and a
runtime/model notice under `third-party/`; [docs/llama-runtime.md](../../../docs/llama-runtime.md)
records the exact source and model revisions.
