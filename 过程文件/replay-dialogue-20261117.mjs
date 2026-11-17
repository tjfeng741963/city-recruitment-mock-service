// 对话回放：按客户端真实链路走一条完整会话，输出逐轮记录。
// 客户端链路 = 新客户先播开场（GET /agent/opening 拉清单逐条发），
// 之后每条消息走 POST /agent/chat（history 全量拼接）。
// 无模型 key，命中话术的轮次显示 guardScript 会强制下发的「运营原文」；
// 自拟轮次标注「由模型生成（需配 key）」。
import fs from "node:fs";

const BASE = "http://127.0.0.1:8080";
const DEVICE = "local-device-001";

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
}).then((r) => r.json());
const headers = { "content-type": "application/json", authorization: "Bearer " + login.access_token };

const ctx = await fetch(`${BASE}/api/v1/agent/context?device_code=${DEVICE}`, { headers }).then((r) => r.json());

// ── 第一幕：开场（新客户第一次进会话，客户端逐条串行发送）──
const out = [];
out.push("═".repeat(64));
out.push(`会话开始 · 新客户加入（设备 ${DEVICE} → 岗位：${ctx.position?.name || ctx.position?.job_title || "深圳地铁安检员"}）`);
out.push("═".repeat(64));
out.push("");
out.push("【开场序列】系统按 seq 逐条发送，上一条确认成功才发下一条，条目间隔 ≥2 秒：");
out.push("");
for (const item of ctx.opening || []) {
  const body = item.kind === "text"
    ? item.content.replace(/\n/g, " ⏎ ").slice(0, 76) + (item.content.length > 76 ? "…" : "")
    : `〔${item.kind === "image" ? "图片" : "视频"}〕${item.media_name}（占位发送，不真实上传）`;
  out.push(`  第${item.seq}条  ${body}`);
}

// ── 解析人设话术库 [S1..S7] 段落，命中时这就是实际下发的原文 ──
const segments = {};
const personaText = String(ctx.persona || "");
const re = /\[(S\d)[^\]]*\]([\s\S]*?)(?=\n\[S\d|$)/g;
let m;
while ((m = re.exec(personaText))) {
  segments[m[1]] = m[2].split(/\n+/).filter((s) => s.trim().length > 8);
}
const scriptTitles = (ctx.scripts || []).map((s) => `${s.id} ${s.title}`).join("、");

// ── 第二幕：多轮对话（DeepSeek 无状态多轮：每轮把之前的输入输出全部拼回 messages）──
// 一条真实会话：嫌远 → 问薪资 → 问社保 → 报名
const CONVO = [
  { user: "你好，看到你发的地铁招聘，是真的吗", route: null },
  { user: "我住东莞，面试地址太远了吧", route: "S1" },
  { user: "那一个月能拿多少？有没有5000？", route: "S2" },
  { user: "买社保吗？之前买过会不会断", route: "S4" },
  { user: "包吃住吗？宿舍什么样的", route: "S5" },
  { user: "可以，我叫张三，13800138000，明天过去面试", route: null },
];

out.push("");
out.push("─".repeat(64));
out.push("【对话阶段】每轮 history 全量拼接（customer 输入 + agent 回复原样 append）：");
out.push("─".repeat(64));

const history = [];
let capture = {};
for (let i = 0; i < CONVO.length; i++) {
  const turn = CONVO[i];
  const dry = await fetch(`${BASE}/api/v1/agent/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ device_code: DEVICE, text: turn.user, history, dry: true }),
  }).then((r) => r.json());

  const systemLen = (dry.messages?.[0]?.content || "").length;
  const round = [];
  round.push("");
  round.push(`— 第 ${i + 1} 轮 ────────────────────────────`);
  round.push(`面试者：${turn.user}`);

  if (turn.route && segments[turn.route]?.length) {
    // 命中话术：模型声明 script_used 后，guardScript 强制回运营原文（第一段）
    const para = segments[turn.route][0].trim();
    round.push(`招工Agent：${para}${segments[turn.route].length > 1 ? `（……后续 ${segments[turn.route].length - 1} 段，同属 ${turn.route} 原文，按需分条发送）` : ""}`);
    round.push(`〔路由〕命中话术库 ${turn.route}，模型声明 script_used → 护栏强制下发运营原文，模型措辞不参与`);
    history.push({ role: "agent", text: para.slice(0, 40) });
  } else {
    round.push(`招工Agent：（自拟回复——由模型生成，数字只能来自事实卡，capture 收集姓名电话；需配 AGENT_LLM_API_KEY 才能看到实际措辞）`);
    round.push(`〔路由〕话术库无此类目 → 模型自拟，护栏仍生效（金额必须在事实里、话术外不得编造）`);
    history.push({ role: "agent", text: "(自拟回复)" });
    // 最后一轮是报名：模拟 capture 效果
    const nameMatch = turn.user.match(/我叫([\u4e00-\u9fa5]{2,4})/);
    const phoneMatch = turn.user.match(/1[3-9]\d{9}/);
    if (nameMatch) capture.name = nameMatch[1];
    if (phoneMatch) capture.phone = phoneMatch[0];
  }
  round.push(`〔system〕本轮 ${systemLen} 字（人设 + 事实卡 + 话术库${scriptTitles ? "：" + scriptTitles : ""}）`);
  if (dry.facts && Object.keys(dry.facts).length) {
    round.push(`〔事实〕工价=${dry.facts.wage_text || "-"} · 班次=${dry.facts.hours_text || "-"} · 地点=${dry.facts.place || "-"}`);
  }
  history.push({ role: "customer", text: turn.user });
  out.push(round.join("\n"));
}

out.push("");
out.push("─".repeat(64));
out.push("【会话末尾】capture 累积：" + JSON.stringify(capture));
out.push("history 最终长度：" + history.length + " 条（下一轮全量传给 /agent/chat，DeepSeek 无状态多轮约定）");
out.push("═".repeat(64));

fs.writeFileSync("过程文件/dialogue-transcript-20261117.txt", out.join("\n"), "utf-8");
console.log(out.join("\n"));
