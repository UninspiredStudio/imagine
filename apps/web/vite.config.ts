import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

const backend = "http://localhost:8080";

export default defineConfig({
  plugins: [
    // The router plugin must run before the React plugin.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
  ],
  // Proxied so the dev server's origin serves the API, registry and session cookies.
  server: {
    proxy: {
      "/api/": { target: backend, changeOrigin: true },
      "/v2": { target: backend, changeOrigin: true },
      "/token": { target: backend, changeOrigin: true },
    },
  },
});
