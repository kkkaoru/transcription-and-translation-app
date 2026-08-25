# Parapper Engine

Kotoba Beacon Native uses the in-process Parapper recognition engine and a
single-direction QuickMT translator.

## Native translation backend

Native loads only `quickmt/quickmt-ja-en` through CTranslate2. The runtime uses
CPU INT8 computation, one replica, one queued batch, and one translation item
per batch. The separate English-to-Japanese model is not loaded. Dropping the
Native translation worker fully unloads QuickMT on capture stop or after one
idle minute.

The former LFM2-350M ONNX implementation is retained at
`reference/lfm2_onnx_translation_engine.rs` and compiled only with the opt-in
`translation-comparison` feature. Its Q4 model occupied 462 MiB on disk and
reached about 781 MiB process RSS in the measured Native translation path. It
is therefore not selected while reducing active-capture RAM is the primary
requirement. The feature preserves the validated LFM2 prompt, ONNX cache
handling, tensor-shape handling, and output cleanup for controlled quality,
latency, and RSS comparisons or a future explicit fallback.
