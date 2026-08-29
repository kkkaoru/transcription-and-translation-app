// Runs with Bun during build and test.
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "vad/**/*"],
      manifest: {
        name: "VAD Lab",
        short_name: "VAD Lab",
        description: "Browser VAD quality and performance laboratory",
        theme_color: "#08131f",
        background_color: "#08131f",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,wasm,mjs,onnx}"],
        cleanupOutdatedCaches: true,
        sourcemap: false,
        maximumFileSizeToCacheInBytes: 20_000_000,
        navigateFallback: "/index.html",
        clientsClaim: false,
        skipWaiting: false,
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: "happy-dom",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 95,
        statements: 95,
      },
    },
  },
});
