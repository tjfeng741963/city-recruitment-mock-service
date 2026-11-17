// 抓 MainLayout 里的菜单文字 + 找出死路由的注册文件
import fs from "node:fs";

// 1) 菜单文字
for (const f of fs.readdirSync("public/assets")) {
  if (!f.startsWith("MainLayout")) continue;
  const src = fs.readFileSync("public/assets/" + f, "utf8");
  const labels = new Set();
  for (const m of src.matchAll(/(?:title|text|label|name):\s*"([\u4e00-\u9fa5A-Za-z ·]{2,16})"/g)) {
    labels.add(m[1]);
  }
  for (const m of src.matchAll(/">\s*([\u4e00-\u9fa5]{2,10})\s*<\/span>/g)) {
    labels.add(m[1]);
  }
  console.log("=== MainLayout 文本 ===");
  console.log([...labels].join(" | "));
}

// 2) 死路由注册在哪个文件
const targets = [
  "/api/v1/flow-nodes", "/api/v1/flow-edges",
  "/api/v1/knowledge", "/api/v1/unknown-questions",
  "/api/v1/webhooks/dify", "/api/v1/channels/wecom-kf/run",
  "/api/v1/agent/jobs", "/api/v1/agent/old-friends",
  "/api/v1/agent/candidates", "/api/v1/agent/evaluations",
  "/api/v1/agent/rules", "/api/v1/agent/invite-group",
  "/api/v1/agent/followup", "/api/v1/agent/reminder-config",
  "/api/v1/agent/report/metrics", "/api/v1/agent/device-scripts",
  "/api/v1/agent/device/:id/workflow", "/api/v1/agent/profile",
  "/api/v1/activation/scripts",
];
console.log("\n=== 死路由 → 注册文件 ===");
for (const f of fs.readdirSync("src/modules", { recursive: true })) {
  if (!String(f).endsWith(".routes.ts")) continue;
  const p = "src/modules/" + String(f).replaceAll("\\", "/");
  const src = fs.readFileSync(p, "utf8");
  const hits = targets.filter((t) => src.includes(`"${t}"`));
  if (hits.length) console.log(p, "→", hits.length, "组:", hits.slice(0, 6).join(", "), hits.length > 6 ? "…" : "");
}
