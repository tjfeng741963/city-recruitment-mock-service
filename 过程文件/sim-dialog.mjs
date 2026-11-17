// 多智能体用户对话模拟：真实调 4222 chat 接口（deepseek），测 Agent 应答质量。
// 画像 × 岗位矩阵，session_key 用 test: 前缀（测完清理）。
import fs from "node:fs";

const BASE = "http://127.0.0.1:8080";
const login = await fetch(BASE + "/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
}).then((r) => r.json());
const TOKEN = login.access_token;
const auth = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

// ── 客户画像（多智能体角色卡）──
const PERSONAS = [
  {
    key: "A-急性子",
    desc: "25 岁男，急着找工作，最关心钱和累不累",
    lines: [
      "你好，这个还在招人吗",
      "一天能挣多少？累不累啊",
      "行，那我明天上午过去看看",
    ],
  },
  {
    key: "B-谨慎详细型",
    desc: "32 岁女，问得细，关心限制和路线",
    lines: [
      "请问下有纹身可以吗，手腕上一小块",
      "面试的话星期天行吗？我看周天休息",
      "面试地点怎么走啊，发个位置图我看看",
      "好的谢谢，要带什么材料",
    ],
  },
  {
    key: "C-收到图测试",
    desc: "28 岁男，怀疑型，专门测图和重发",
    lines: [
      "发个面试地点的图给我看看",
      "没收到啊，重新发一下",
    ],
  },
];

// ── 被测岗位：1=深圳（设备实际绑定），3=广州（有地点图绑定）──
const POSITIONS = [
  { id: 1, name: "深圳_地铁安检员" },
  { id: 3, name: "广州_地铁安检员" },
];

const transcript = [];
for (const pos of POSITIONS) {
  for (const persona of PERSONAS) {
    const sessionKey = `test:${pos.id}:${persona.key}:${Date.now()}`;
    const convo = { position: pos.name, position_id: pos.id, persona: persona.key, persona_desc: persona.desc, rounds: [], issues: [] };
    for (const line of persona.lines) {
      const res = await fetch(BASE + "/api/v1/agent/chat", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ position_id: pos.id, text: line, session_key: sessionKey }),
      });
      const j = await res.json();
      if (!res.ok) {
        convo.rounds.push({ customer: line, error: j.detail || res.status });
        convo.issues.push(`HTTP ${res.status}: ${j.detail}`);
        break;
      }
      // 响应结构：j.reply.messages 才是给客户的话；顶层 j.messages 是 LLM 调试信息
      const msgs = ((j.reply && j.reply.messages) || []).map((m) =>
        m.type === "text" ? { kind: "文本", content: String(m.content || "") } : { kind: m.type === "image" ? "图片" : m.type === "video" ? "视频" : "未知", name: String(m.name || "") },
      );
      convo.rounds.push({ customer: line, reply: msgs, capture: (j.reply && j.reply.capture) || null, interview: (j.reply && j.reply.interview) || null });
    }
    transcript.push(convo);
    console.log(`完成 ${pos.name} × ${persona.key}：${convo.rounds.length} 轮`);
  }
}

fs.writeFileSync("data/.sim-transcript.json", JSON.stringify(transcript, null, 1));
console.log("记录已存 data/.sim-transcript.json");
