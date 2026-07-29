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
