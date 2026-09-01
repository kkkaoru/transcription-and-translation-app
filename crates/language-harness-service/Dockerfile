FROM rust:1.97.1-trixie@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f AS builder
WORKDIR /build
COPY language-harness-core language-harness-core
COPY language-harness-service language-harness-service
RUN cargo build --locked --release --manifest-path language-harness-service/Cargo.toml && \
    strip language-harness-service/target/release/language-harness-service && \
    mkdir -p /runtime/lib && \
    find language-harness-service/target/release -maxdepth 2 -type f -name 'libonnxruntime.so*' \
      -exec cp '{}' /runtime/lib/ \;

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS model
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /models/speechbrain-ecapa && \
    curl -fL --retry 3 -o /models/speechbrain-ecapa/lang-id-ecapa.onnx \
      'https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/41e60dea31b80ea5d4f9d9d9e818501ea184e568/lang-id-ecapa.onnx' && \
    curl -fL --retry 3 -o /models/speechbrain-ecapa/lang-id-ecapa.onnx.data \
      'https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/41e60dea31b80ea5d4f9d9d9e818501ea184e568/lang-id-ecapa.onnx.data' && \
    curl -fL --retry 3 -o /models/speechbrain-ecapa/labels.json \
      'https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/41e60dea31b80ea5d4f9d9d9e818501ea184e568/labels.json' && \
    echo '4af3b6a5b4165f78715fe363ed6b7650d5f77ed0a6e2966c500eadc46252a288  /models/speechbrain-ecapa/lang-id-ecapa.onnx' | sha256sum -c - && \
    echo '78fefd776536f4a686bcf705dedb8e9a497b924a2107a949b42a24b2b90174a2  /models/speechbrain-ecapa/lang-id-ecapa.onnx.data' | sha256sum -c - && \
    echo '9e515c3c7932659fd1e6c3febc395529d0a8092328adb9f5e75185a04bb523d0  /models/speechbrain-ecapa/labels.json' | sha256sum -c -

FROM debian:trixie-slim@sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132 AS final
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/language-harness-service/target/release/language-harness-service /usr/local/bin/language-harness-service
COPY --from=builder /runtime/lib /usr/local/lib
COPY --from=model /models/speechbrain-ecapa /models/speechbrain-ecapa
ENV LD_LIBRARY_PATH=/usr/local/lib
ENV LANGUAGE_MODEL_DIR=/models/speechbrain-ecapa
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/language-harness-service"]
