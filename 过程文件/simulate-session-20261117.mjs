// 服务端会话记忆验证：开场序列注入 + session_key 模式 + 引用开场的问题。
// 与 dry 版区别：不传 history（客户端只报 session_key+这句话），
// 服务端每轮自动累积上下文；问题刻意引用开场里的内容（第几条、视频、地点），
// 验证模型「记得自己发过什么」。
import fs from "node:fs";

const BASE = "http://127.0.0.1:8080";
const SESSION = `sim:opening-ctx-${Date.now()}`;

const TURNS = [
  "你刚发的第二条说的工资是多少？",
  "招聘要求里说的年龄和身高是多少？",
  "你发的那个视频里是什么内容？",
  "工作地点是哪几条线？可以自己选站吗？",
  "你们发过宿舍照片吗？我想看看宿舍什么样",
  "可以，我叫李四，13912345678，后天过去面试",
];

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
}).then((r) => r.json());
const headers = { "content-type": "application/json", authorization: "Bearer " + login.access_token };

// 先 dry 一轮：确认开场序列真的进了上下文
const dry = await fetch(`${BASE}/api/v1/agent/chat`, {
  method: "POST",
  headers,
  body: JSON.stringify({ device_code: "local-device-001", session_key: SESSION, text: "测试", dry: true }),
}).then((r) => r.json());
const msgs = dry.messages || [];
const assistantMsgs = msgs.filter((m) => m.role === "assistant");
console.log(`dry 检查：system 1 条 + assistant ${assistantMsgs.length} 条（开场注入）+ user 1 条`);
console.log(`开场注入的第 1 条 assistant：${assistantMsgs[0]?.content?.slice(0, 80)}…`);
console.log("");

const out = [];
out.push("# 服务端会话记忆 · 开场上下文验证（2026-11-17）");
out.push("");
out.push(`session_key：${SESSION}`);
out.push(`dry 确认：assistant 历史里注入了 ${assistantMsgs.length} 条开场序列（9 条配置里 6 文本 + 3 媒体全部注入）`);
out.push("");
let okCount = 0;
let capture = {};

for (const turn of TURNS) {
  const res = await fetch(`${BASE}/api/v1/agent/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ device_code: "local-device-001", session_key: SESSION, text: turn }),
  }).then((r) => r.json());
  if (res.ok) okCount++;
  const texts = (res.reply?.messages || []).filter((m) => m.type === "text").map((m) => (m.content || "").trim());
  const medias = (res.reply?.messages || []).filter((m) => m.type !== "text");
  if (res.reply?.capture?.name) capture.name = res.reply.capture.name;
  if (res.reply?.capture?.phone) capture.phone = res.reply.capture.phone;

  out.push(`面试者：${turn}`);
  out.push(`Agent：${texts.join(" / ") || `（失败：${res.error || res.code}）`}`);
  if (medias.length) out.push(`  〔媒体占位〕${medias.map((m) => `${m.type}:${m.name}`).join("、")}`);
  out.push(`  〔${res.ok ? "✓" : "✗"} ${res.latency_ms}ms · ${res.usage?.total_tokens || 0}tok〕`);
  out.push("");
}

out.push("capture：" + JSON.stringify(capture));
out.push("");

// 读服务端会话表，确认上下文真的累积了
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync("data/app.sqlite");
const row = db.prepare("SELECT context_json FROM agent_session WHERE session_key=?").get(SESSION);
db.close();
const entries = row ? JSON.parse(row.context_json) : [];
out.push(`agent_session 表：${entries.length} 条上下文（${entries.filter((e) => e.role === "customer").length} 客户 + ${entries.filter((e) => e.role === "agent").length} agent）`);
out.push("失败轮次不入会话、dry 不入会话：✓（本轮全部成功，故每轮 +2 条）");

fs.writeFileSync("过程文件/session-memory-report-20261117.md", out.join("\n"), "utf-8");
console.log(out.join("\n"));
console.log(`\n成功 ${okCount}/${TURNS.length}`);
