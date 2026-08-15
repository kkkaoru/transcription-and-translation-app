import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveBuildIdentity, writeRustBuildIdentity } from "./build-identity.mjs";

export default defineConfig(({ command }) => {
  const identity = resolveBuildIdentity(command);
  writeRustBuildIdentity(identity);

  return {
    define: {
      __KOTOBA_APP_VERSION__: JSON.stringify(identity.appVersion),
      __KOTOBA_BUILD_ID__: JSON.stringify(identity.buildId),
    },
    plugins: [react()],
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 1420,
      strictPort: true,
      watch: {
        ignored: ["**/.tools/**", "**/node_modules/**", "**/src-tauri/target/**", "**/target/**"],
      },
    },
    build: {
      target: "es2022",
      // Production webview does not need source maps (~2MB). Keep them off so
      // Tauri's frontendDist copy stays small.
      sourcemap: false,
    },
  };
});
