import path from "node:path";

export const config = {
  host: process.env.REA_HOST ?? "127.0.0.1",
  port: Number(process.env.REA_PORT ?? 8080),
  jwtSecret: process.env.REA_LOCAL_JWT_SECRET ?? "local-development-secret",
  databasePath: process.env.REA_DATABASE_PATH ?? undefined,
  // 前端固定为 public/ 下的 Vue 版本；REA_FRONTEND_DIR 仅保留作覆盖入口，无需设置。
  frontendDir: () => path.resolve(process.cwd(), process.env.REA_FRONTEND_DIR ?? "public"),
  // 上传文件落盘目录。默认跟数据库同卷（线上 = /data/uploads），因为容器根文件
  // 系统只读，只有 ./data:/data 这个卷可写；本地开发退化为 ./data/uploads。
  uploadsDir: () => {
    const explicit = (process.env.REA_UPLOADS_DIR ?? "").trim();
    if (explicit) return path.resolve(explicit);
    const dbPath = (process.env.REA_DATABASE_PATH ?? "").trim();
    if (dbPath && dbPath !== ":memory:") return path.join(path.dirname(path.resolve(dbPath)), "uploads");
    return path.resolve(process.cwd(), "data", "uploads");
  },
};
