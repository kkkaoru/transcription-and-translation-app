FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS llama-builder
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates cmake g++ git make && rm -rf /var/lib/apt/lists/*
RUN git clone --filter=blob:none https://github.com/azooKey/llama.cpp.git /src && cd /src && git checkout 88b97a47dc7f5892e2d5a6856fbe9cfe237f9e5c
RUN cmake -S /src -B /build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=ON \
      -DGGML_NATIVE=OFF \
      -DGGML_OPENMP=OFF && \
    cmake --build /build --target llama-server -j2 && \
    strip /build/bin/llama-server

FROM rust:1.88-bookworm@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0 AS n5-builder
RUN git clone --filter=blob:none https://github.com/kkkaoru/transcription-and-translation-app.git /repo && \
    cd /repo && git checkout 88fd4424dde90b28b517e4dfb93710eeaefaa7fe && \
    git submodule update --init --depth 1 submodules/AzooKeyKanaKanjiConverter
COPY n5-server /repo/apps/zenz-container/n5-server
RUN cargo build --locked --release --manifest-path /repo/apps/zenz-container/n5-server/Cargo.toml && \
    strip /repo/apps/zenz-container/n5-server/target/release/zenz-container-entrypoint

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS model
ARG MODEL=xsmall
ARG N5_LM=off
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/* && \
    case "$MODEL" in \
      xsmall) URL='https://huggingface.co/Miwa-Keita/zenz-v3.2-xsmall-gguf/resolve/4f5423f0fad41a73b1242eb96fe5c12ae4fdca83/ggml-model-Q5_K_M.gguf'; SHA='00c64b3d318045a708d0cad5434faccab10f5481a49e6362864551fd0995fa58' ;; \
      small) URL='https://huggingface.co/Miwa-Keita/zenz-v3.2-small-gguf/resolve/c67e03e07d215c869f591b274c1631170d3e11fe/ggml-model-Q5_K_M.gguf'; SHA='29c223d4c23327b80fd13ebb5ab2555057a46317997d5da391584ffbef0db673' ;; \
      *) echo "Unsupported MODEL=$MODEL" >&2; exit 2 ;; \
    esac && \
    mkdir -p /models && \
    curl -fL --retry 3 -o /models/model.gguf "$URL" && \
    echo "$SHA  /models/model.gguf" | sha256sum -c - && \
    if [ "$N5_LM" = on ]; then \
      curl -fL --retry 3 -o /tmp/input_n5_lm_v1.zip 'https://huggingface.co/Miwa-Keita/input_n5_lm_v1/resolve/6153c4693ee202049b6cb834396e658562c147b3/input_n5_lm_v1.zip' && \
      echo '0aaf326140a92d577b2020905346672b8cc4c47e63516328add0f197568aaf7a  /tmp/input_n5_lm_v1.zip' | sha256sum -c - && \
      unzip -q /tmp/input_n5_lm_v1.zip -d /models && \
      rm -f /tmp/input_n5_lm_v1.zip /models/input_n5_lm_v1/lm_c_bc.marisa && \
      touch /models/input_n5_lm_v1/.enabled; \
    elif [ "$N5_LM" != off ]; then \
      echo "Unsupported N5_LM=$N5_LM" >&2; exit 2; \
    fi
COPY --from=n5-builder /repo/submodules/AzooKeyKanaKanjiConverter/Sources/EfficientNGram/tokenizer /tmp/tokenizer
RUN if [ "$N5_LM" = on ]; then mv /tmp/tokenizer /models/input_n5_lm_v1/tokenizer; else rm -rf /tmp/tokenizer; fi

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=llama-builder --chown=nonroot:nonroot /build/bin/llama-server /usr/local/bin/llama-server
COPY --from=n5-builder --chown=nonroot:nonroot /repo/apps/zenz-container/n5-server/target/release/zenz-container-entrypoint /usr/local/bin/zenz-entrypoint
COPY --from=model --chown=nonroot:nonroot /models /models
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/zenz-entrypoint", "/usr/local/bin/llama-server"]
