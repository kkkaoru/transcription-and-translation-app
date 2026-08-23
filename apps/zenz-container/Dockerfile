FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS builder
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

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS model
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

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=builder --chown=nonroot:nonroot /build/bin/llama-server /usr/local/bin/llama-server
COPY --from=model --chown=nonroot:nonroot /models/model.gguf /models/model.gguf
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/llama-server"]
