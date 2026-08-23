const workerOrigin = (process.env.COMPARE_ASR_ORIGIN ?? "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  webpack: (config) => {
    // Silero VAD loads /ort/*.wasm at runtime; keep the large JSEP binary external.
    config.resolve.conditionNames = ["onnxruntime-web-use-extern-wasm", "..."];
    return config;
  },
  ...(process.env.NODE_ENV === "development"
    ? {
        rewrites() {
          return [
            {
              source: "/v1/speech/workers-ai/azookey",
              destination: `${workerOrigin}/v1/speech/workers-ai/azookey`,
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
