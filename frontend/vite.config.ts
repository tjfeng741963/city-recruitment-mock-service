import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export const uiAlias = { "@ui": fileURLToPath(new URL("./ui", import.meta.url)) };

export default defineConfig({
  plugins: [react()],
  resolve: { alias: uiAlias },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
