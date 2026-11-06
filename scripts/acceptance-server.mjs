import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runDir = process.env.ACCEPTANCE_RUN_DIR;
if (!runDir || !path.isAbsolute(runDir) || !process.env.ACCEPTANCE_PASSWORD) {
  throw new Error("Start this server through scripts/acceptance-smoke.py");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Migration discovery is relative to the repository; runtime data stays in runDir.
process.chdir(root);
process.env.REA_HOST = "127.0.0.1";
process.env.REA_DATABASE_PATH = path.join(runDir, "node.sqlite");
process.env.REA_FRONTEND_DIR = path.join(root, "public");
process.env.REA_LOCAL_SEED_PASSWORD = process.env.ACCEPTANCE_PASSWORD;
process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
process.env.REA_DIFY_PROVIDER = "mock";
process.env.REA_WECOM_ENABLED = "false";

const { buildServer } = await import("../src/server.ts");
const app = buildServer();
const url = await app.listen({ host: "127.0.0.1", port: 0 });
await fs.writeFile(path.join(runDir, "node-ready.json"), JSON.stringify({ url }), "utf8");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
