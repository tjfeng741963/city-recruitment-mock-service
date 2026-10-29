import { existsSync } from "node:fs";
import path from "node:path";

const builtFrontend = path.resolve(process.cwd(), "frontend", "dist");

export const config = {
  host: process.env.REA_HOST ?? "127.0.0.1",
  port: Number(process.env.REA_PORT ?? 8080),
  jwtSecret: process.env.REA_LOCAL_JWT_SECRET ?? "local-development-secret",
  databasePath: process.env.REA_DATABASE_PATH ?? undefined,
  // New React build when present; REA_FRONTEND_DIR=public serves the captured legacy Vue bundle.
  frontendDir: () =>
    path.resolve(process.cwd(), process.env.REA_FRONTEND_DIR ?? (existsSync(path.join(builtFrontend, "index.html")) ? builtFrontend : "public")),
};
