#!/usr/bin/env sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

runtime_dir="src-tauri/macos-runtime"

mkdir -p "$runtime_dir"

copy_runtime_library() {
  library="$1"
  if [ -e "$runtime_dir/$library" ]; then
    return 0
  fi

  source_path=""
  for source_dir in \
    "target/release" \
    "target/debug" \
    "target/${TARGET_TRIPLE:-}/release" \
    "target/${TARGET_TRIPLE:-}/debug" \
    "target/${CARGO_BUILD_TARGET:-}/release" \
    "target/${CARGO_BUILD_TARGET:-}/debug" \
    "target/sherpa-onnx-prebuilt/${SHERPA_PREBUILT_DIR:-}/lib" \
    "target/sherpa-onnx-prebuilt/sherpa-onnx-v1.12.39-osx-arm64-shared-lib/lib"
  do
    if [ -f "$source_dir/$library" ]; then
      source_path="$source_dir/$library"
      break
    fi
  done

  if [ -z "$source_path" ]; then
    echo "Missing macOS runtime library: $library" >&2
    exit 1
  fi
  cp "$source_path" "$runtime_dir/$library"
}

copy_runtime_library libsherpa-onnx-c-api.dylib
copy_runtime_library libsherpa-onnx-cxx-api.dylib
copy_runtime_library libonnxruntime.1.24.4.dylib

# Parapper links the versioned ONNX dylib. Keep the unversioned name as a
# relative symlink so the runtime directory is not doubled (~25MB).
onnx_unversioned="$runtime_dir/libonnxruntime.dylib"
onnx_versioned="$runtime_dir/libonnxruntime.1.24.4.dylib"
if [ -L "$onnx_unversioned" ]; then
  :
elif [ -f "$onnx_unversioned" ] && cmp -s "$onnx_unversioned" "$onnx_versioned"; then
  rm "$onnx_unversioned"
  ln -s libonnxruntime.1.24.4.dylib "$onnx_unversioned"
elif [ ! -e "$onnx_unversioned" ]; then
  ln -s libonnxruntime.1.24.4.dylib "$onnx_unversioned"
fi
