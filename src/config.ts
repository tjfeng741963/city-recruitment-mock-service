import path from "node:path";

export const config = {
  host: process.env.REA_HOST ?? "127.0.0.1",
  port: Number(process.env.REA_PORT ?? 8080),
  jwtSecret: process.env.REA_LOCAL_JWT_SECRET ?? "local-development-secret",
  databasePath: process.env.REA_DATABASE_PATH ?? undefined,
  // 前端固定为 public/ 下的 Vue 版本；REA_FRONTEND_DIR 仅保留作覆盖入口，无需设置。
  frontendDir: () => path.resolve(process.cwd(), process.env.REA_FRONTEND_DIR ?? "public"),
};
