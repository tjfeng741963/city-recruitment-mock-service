import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { uiAlias } from "./vite.config";

export default defineConfig({
  root: fileURLToPath(new URL("./showcase", import.meta.url)),
  plugins: [react()],
  resolve: { alias: uiAlias },
  server: { port: 5174 },
  build: {
    outDir: fileURLToPath(new URL("./dist-showcase", import.meta.url)),
    emptyOutDir: true,
  },
});
