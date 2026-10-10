import { defineConfig } from "vite";

// Cross-origin isolation enables SharedArrayBuffer, which we'll want once the
// toolchain uses threads or a blocking FS bridge. It's harmless until then.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  // Relative asset URLs, so dist/ works from any subfolder (e.g. example.com/esp-wasm/).
  base: "./",
  server: {
    headers: crossOriginIsolation,
    // toolchain/out holds gigabytes of LLVM/ESP-IDF sources; watching it pins the CPU.
    watch: { ignored: ["**/toolchain/**"] },
  },
  // Only scan the app for dependencies, not HTML files deep inside toolchain/out.
  optimizeDeps: { entries: ["index.html"] },
  preview: { headers: crossOriginIsolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
