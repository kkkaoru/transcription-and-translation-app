const inferenceOrigin = (process.env.COMPARE_INFERENCE_ORIGIN ?? "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);
const asrOrigin = (process.env.COMPARE_ASR_ORIGIN ?? "http://127.0.0.1:8790").replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  webpack: (config) => {
    // Load `/ort/*.wasm` at runtime. The default onnxruntime-web bundle
    // emits jsep.wasm (~26 MiB), which exceeds Cloudflare Workers' 25 MiB cap.
    config.resolve.conditionNames = ["onnxruntime-web-use-extern-wasm", "..."];
    return config;
  },
  ...(process.env.NODE_ENV === "development"
    ? {
        rewrites() {
          return [
            { source: "/ws/azookey", destination: `${inferenceOrigin}/ws/azookey` },
            { source: "/v1/azookey", destination: `${inferenceOrigin}/v1/azookey` },
            {
              source: "/v1/asr/workers-ai/transcriptions",
              destination: `${asrOrigin}/v1/asr/workers-ai/transcriptions`,
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
