// 面试档案验证：模型 JSON（interview）判断 + agent_archive 累积/覆盖。
// 流程：先问问题（不约）→ 约明天 → 改后天 → 再改具体时段 → 查档案全程变化。
import fs from "node:fs";

const BASE = "http://127.0.0.1:8080";
const SESSION = `sim:archive-${Date.now()}`;

const TURNS = [
  "包吃住吗？",                                          // 不约，档案不应有面试
  "可以，明天上午过来面试。我叫王五，13711112222",        // 约明天 → 2026-11-18 10:00
  "等等，我明天有事，改到后天上午吧",                    // 改后天 → 2026-11-19
  "后天下午2点行不行？上午赶不过去",                     // 改具体时段 → 14:00
];

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
}).then((r) => r.json());
const headers = { "content-type": "application/json", authorization: "Bearer " + login.access_token };

const out = [];
out.push("# 面试档案验证 · interview 字段 + agent_archive（2026-11-17）");
out.push("");
out.push(`session_key：${SESSION}`);
out.push("");

async function getArchive() {
  const res = await fetch(`${BASE}/api/v1/agent/archive?session_key=${encodeURIComponent(SESSION)}`, { headers });
  return res.json();
}

for (const turn of TURNS) {
  const res = await fetch(`${BASE}/api/v1/agent/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ device_code: "local-device-001", session_key: SESSION, text: turn }),
  }).then((r) => r.json());
  const texts = (res.reply?.messages || []).filter((m) => m.type === "text").map((m) => (m.content || "").trim());
  const iv = res.reply?.interview || {};
  const arc = res.archive;

  out.push(`面试者：${turn}`);
  out.push(`Agent：${texts.join(" / ") || `（失败：${res.error || res.code}）`}`);
  out.push(`  〔interview JSON〕date=${iv.date || "(空)"} time=${iv.time || "(空)"} confirmed=${iv.confirmed ?? false}`);
  out.push(`  〔档案〕${arc ? `姓名=${arc.name || "-"} 电话=${arc.phone || "-"} 日期=${arc.interview_date || "-"} 时段=${arc.interview_time || "-"} 已定=${arc.interview_confirmed}` : "null"}`);
  out.push("");
}

const final = await getArchive();
out.push("## 最终档案（GET /api/v1/agent/archive）");
out.push("");
out.push("```json");
out.push(JSON.stringify(final.archive, null, 2));
out.push("```");

fs.writeFileSync("过程文件/archive-report-20261117.md", out.join("\n"), "utf-8");
console.log(out.join("\n"));
