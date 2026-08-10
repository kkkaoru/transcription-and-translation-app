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
};

export default nextConfig;
