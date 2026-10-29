import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@ui": fileURLToPath(new URL("./frontend/ui", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
