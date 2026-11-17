// 真实模型模拟：dry=false，10 个用户画像逐轮对话。
// 与 dry 版差异：agent 回复用模型真实输出拼接进 history（DeepSeek 无状态多轮约定），
// 并记录 script_used 声明、护栏结果、金额校验、延迟与 token 用量。
import fs from "node:fs";

const BASE = "http://127.0.0.1:8080";
const DEVICE = "local-device-001";

const USERS = [
  { name: "U1 直奔薪资", turns: ["一个月能拿多少？", "有没有5000？"] },
  { name: "U2 年龄超龄", turns: ["我36岁女的，可以做吗？"] },
  { name: "U3 嫌地址远", turns: ["我家住东莞，面试地址太远了吧", "有没有近一点的站点？"] },
  { name: "U4 问社保", turns: ["买社保吗？", "之前买过社保会不会断？"] },
  { name: "U5 问吃住", turns: ["包吃住吗？宿舍什么样的？"] },
  { name: "U6 连班顾虑", turns: ["要连班吗？会不会很累？", "一天要站多久？"] },
  { name: "U7 犹豫对比", turns: ["我再考虑一下，对比下别家", "你们这和别家比有什么优势？"] },
  { name: "U8 问福利", turns: ["有什么福利？坐地铁免费吗？"] },
  { name: "U9 直接报名", turns: ["可以，我叫张三，13800138000，明天过去面试"] },
  { name: "U10 纯闲聊", turns: ["你好", "在吗？"] },
];

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
}).then((r) => r.json());
const headers = { "content-type": "application/json", authorization: "Bearer " + login.access_token };

const rows = [];
const transcripts = [];
let totalTokens = 0;

for (const user of USERS) {
  const history = [];
  const convo = [`── ${user.name} ──`];
  for (const turn of user.turns) {
    const res = await fetch(`${BASE}/api/v1/agent/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ device_code: DEVICE, text: turn, history, dry: false }),
    }).then((r) => r.json());
    totalTokens += res.usage?.total_tokens || 0;

    const texts = (res.reply?.messages || [])
      .filter((m) => m.type === "text")
      .map((m) => (m.content || "").trim())
      .filter(Boolean);
    const medias = (res.reply?.messages || []).filter((m) => m.type !== "text");
    const agentReply = texts.join(" / ") || (res.ok ? "（空回复）" : `（失败：${res.error || res.code}）`);

    convo.push(`面试者：${turn}`);
    convo.push(`Agent：${agentReply}`);
    if (medias.length) convo.push(`  〔媒体占位〕${medias.map((m) => `${m.type}:${m.name}`).join("、")}`);
    const flags = [];
    if (res.script_used) flags.push(`声明话术 ${res.script_used}`);
    if (res.script_replaced) flags.push("护栏替换回原文");
    if (res.reply?.capture?.name) flags.push(`收姓名=${res.reply.capture.name}`);
    if (res.reply?.capture?.phone) flags.push(`收电话=${res.reply.capture.phone}`);
    if (res.reply?.handoff) flags.push("转人工");
    if (res.reply?.done) flags.push("done");
    flags.push(`${res.latency_ms}ms`, `${res.usage?.total_tokens || 0}tok`);
    if (!res.ok) flags.push(`⚠ ${res.error || res.code}`);
    convo.push(`  〔${flags.join(" · ")}〕`);
    if (texts[0] && texts[0].length > 90) convo.push(`  〔首发内容〕${texts[0].slice(0, 90)}…`);

    rows.push({
      user: user.name,
      turn,
      ok: res.ok,
      script_used: res.script_used || "-",
      replaced: res.script_replaced ? "是" : "否",
      latency: res.latency_ms || 0,
      tokens: res.usage?.total_tokens || 0,
      capture_name: res.reply?.capture?.name || "",
      capture_phone: res.reply?.capture?.phone || "",
      error: res.error || res.code || "",
    });
    history.push({ role: "customer", text: turn });
    history.push({ role: "agent", text: texts[0] || agentReply });
  }
  transcripts.push(convo.join("\n"));
}

const report = [];
report.push("# 真实模型模拟 · deepseek-chat（2026-11-17）");
report.push("");
report.push(`- 轮次：${rows.length}，总 token：${totalTokens}`);
report.push(`- 成功：${rows.filter((r) => r.ok).length}；失败：${rows.filter((r) => !r.ok).length}`);
report.push(`- 声明话术：${rows.filter((r) => r.script_used !== "-").length} 轮；护栏替换回原文：${rows.filter((r) => r.replaced === "是").length} 轮`);
report.push(`- capture 收到姓名：${rows.filter((r) => r.capture_name).length} 轮；电话：${rows.filter((r) => r.capture_phone).length} 轮`);
const avgLatency = Math.round(rows.reduce((s, r) => s + r.latency, 0) / rows.length);
report.push(`- 平均延迟：${avgLatency}ms`);
report.push("");
report.push("## 逐轮明细");
report.push("");
report.push("| 用户 | 客户说 | script_used | 替换 | 延迟ms | tok | capture | 备注 |");
report.push("|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const cap = [r.capture_name, r.capture_phone].filter(Boolean).join("/") || "-";
  report.push(`| ${r.user} | ${r.turn} | ${r.script_used} | ${r.replaced} | ${r.latency} | ${r.tokens} | ${cap} | ${r.error || (r.ok ? "✓" : "✗")} |`);
}
report.push("");
report.push("## 完整对话记录");
report.push("");
report.push(transcripts.join("\n\n"));

fs.writeFileSync("过程文件/simulate-real-report-20261117.md", report.join("\n"), "utf-8");
console.log(report.join("\n"));
