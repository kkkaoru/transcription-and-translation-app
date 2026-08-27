ARG N5_LM=off

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS llama-builder
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://github.com/azooKey/llama.cpp.git /src && cd /src && git checkout 88b97a47dc7f5892e2d5a6856fbe9cfe237f9e5c && \
    printf 'disabled' | gzip -9 > /src/examples/server/public/index.html.gz
RUN cmake -S /src -B /build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=ON \
      -DGGML_NATIVE=OFF \
      -DGGML_OPENMP=OFF \
      -DGGML_CPU_AARCH64=OFF && \
    cmake --build /build --target llama-server -j1 && \
    strip /build/bin/llama-server && \
    mkdir -p /runtime/lib/x86_64-linux-gnu /runtime/lib64 /runtime/tmp && \
    cp /lib/x86_64-linux-gnu/libc.so.6 \
       /lib/x86_64-linux-gnu/libgcc_s.so.1 \
       /lib/x86_64-linux-gnu/libm.so.6 \
       /lib/x86_64-linux-gnu/libstdc++.so.6 \
       /runtime/lib/x86_64-linux-gnu/ && \
    cp /lib64/ld-linux-x86-64.so.2 /runtime/lib64/ && \
    chmod 1777 /runtime/tmp

FROM rust:1.88-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS n5-builder
RUN git clone --filter=blob:none https://github.com/kkkaoru/transcription-and-translation-app.git /repo && \
    cd /repo && git checkout 88fd4424dde90b28b517e4dfb93710eeaefaa7fe && \
    git submodule update --init --depth 1 submodules/AzooKeyKanaKanjiConverter
COPY n5-server /repo/apps/zenz-container/n5-server
RUN cargo build --locked --release --manifest-path /repo/apps/zenz-container/n5-server/Cargo.toml && \
    strip /repo/apps/zenz-container/n5-server/target/release/zenz-container-entrypoint

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS gguf-model
ARG MODEL=xsmall
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && \
    case "$MODEL" in \
      xsmall) URL='https://huggingface.co/Miwa-Keita/zenz-v3.2-xsmall-gguf/resolve/4f5423f0fad41a73b1242eb96fe5c12ae4fdca83/ggml-model-Q5_K_M.gguf'; SHA='00c64b3d318045a708d0cad5434faccab10f5481a49e6362864551fd0995fa58' ;; \
      small) URL='https://huggingface.co/Miwa-Keita/zenz-v3.2-small-gguf/resolve/c67e03e07d215c869f591b274c1631170d3e11fe/ggml-model-Q5_K_M.gguf'; SHA='29c223d4c23327b80fd13ebb5ab2555057a46317997d5da391584ffbef0db673' ;; \
      *) echo "Unsupported MODEL=$MODEL" >&2; exit 2 ;; \
    esac && \
    mkdir -p /models && \
    curl -fL --retry 3 -o /models/model.gguf "$URL" && \
    echo "$SHA  /models/model.gguf" | sha256sum -c -

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS n5-model
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/* && \
    curl -fL --retry 3 -o /tmp/input_n5_lm_v1.zip 'https://huggingface.co/Miwa-Keita/input_n5_lm_v1/resolve/6153c4693ee202049b6cb834396e658562c147b3/input_n5_lm_v1.zip' && \
    echo '0aaf326140a92d577b2020905346672b8cc4c47e63516328add0f197568aaf7a  /tmp/input_n5_lm_v1.zip' | sha256sum -c - && \
    unzip -q /tmp/input_n5_lm_v1.zip -d /models && \
    rm -rf /tmp/input_n5_lm_v1.zip /models/__MACOSX \
      /models/input_n5_lm_v1/.DS_Store \
      /models/input_n5_lm_v1/lm_c_bc.marisa
COPY --from=n5-builder /repo/submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer/vocab.json /models/input_n5_lm_v1/tokenizer/vocab.json
COPY --from=n5-builder /repo/submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer/merges.txt /models/input_n5_lm_v1/tokenizer/merges.txt

FROM scratch AS runtime-common
COPY --from=llama-builder /runtime /
COPY --from=llama-builder /build/bin/llama-server /usr/local/bin/llama-server
COPY --from=gguf-model /models/model.gguf /models/model.gguf
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/llama-server"]

FROM runtime-common AS runtime-off

FROM runtime-common AS runtime-on
COPY --from=n5-builder /repo/apps/zenz-container/n5-server/target/release/zenz-container-entrypoint /usr/local/bin/zenz-entrypoint
COPY --from=n5-model /models/input_n5_lm_v1 /models/input_n5_lm_v1
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/zenz-entrypoint", "/usr/local/bin/llama-server"]

# Isolated capability probes only. Production profiles never select these stages.
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runtime-snapshot-diagnostic
COPY --from=llama-builder /build/bin/llama-server /usr/local/bin/llama-server
COPY --from=gguf-model /models/model.gguf /models/model.gguf
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/llama-server"]

FROM runtime-${N5_LM} AS final
