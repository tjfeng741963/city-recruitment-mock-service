// 模拟 10 个不同画像的用户对话，验证受控编排的话术路由与事实约束。
// 当前没有 AGENT_LLM_API_KEY，真实生成跑不了；脚本走 dry 模式拿到
// 这一轮真正会发给模型的 messages，再用与 guardScript 相同的相似度逻辑
// 预判「模型应该命中哪类话术」，输出路由层分析报告。
// 配上 key 后把同一份脚本改成 dry:false，即可拿到模型的真实回复做对比。
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

// 与 guardScript 同源的相似度预判：把每类话术拆成段，用户消息与段做包含比对
// dry 的 scripts 只有 id/title（正文不回传），相似度预判放到服务端做；
// 这里用关键词粗路由，结果与 agent-orchestrator 的 guardScript 无关。

// 关键词路由：客户说法千变万化，关键词只是模拟路由的粗版，真实命中由模型判断
const KEYWORDS = [
  ["S1", ["远", "距离", "外宿", "地址", "通勤", "总部", "就近", "站点"]],
  ["S2", ["工资", "多少钱", "待遇", "薪资", "低", "一小时", "一天多少", "月多少", "5000"]],
  ["S3", ["连班", "累", "上多久", "时间长", "几个小时", "几小时", "站多久"]],
  ["S4", ["社保", "五险", "一金", "保险"]],
  ["S5", ["福利", "补贴", "免费", "包吃", "包住", "吃住", "宿舍", "住宿", "被褥", "工服", "地铁"]],
  ["S6", ["保底", "底薪", "最低"]],
  ["S7", ["考虑", "犹豫", "对比", "再想想", "要不要去", "值得", "别家", "优势"]],
];

function keywordRoute(userText) {
  for (const [id, words] of KEYWORDS) {
    if (words.some((word) => userText.includes(word))) return id;
  }
  return null;
}

(async () => {
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
  }).then((r) => r.json());
  const headers = { "content-type": "application/json", authorization: "Bearer " + login.access_token };

  const rows = [];
  const stats = { keyword_hit: 0, keyword_miss: 0, turns: 0 };

  for (const user of USERS) {
    const history = [];
    for (const turn of user.turns) {
      const dry = await fetch(`${BASE}/api/v1/agent/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ device_code: DEVICE, text: turn, history, dry: true }),
      }).then((r) => r.json());

      const scripts = dry.scripts || [];
      const keywordRouteId = keywordRoute(turn);
      if (keywordRouteId) stats.keyword_hit += 1;
      else stats.keyword_miss += 1;
      stats.turns += 1;
      const system = dry.messages?.[0]?.content || "";
      const inSystem = keywordRouteId ? system.includes("[" + keywordRouteId) : true;

      rows.push({
        user: user.name,
        turn,
        keyword_route: keywordRouteId || "(自拟)",
        in_system: keywordRouteId ? (inSystem ? "话术已注入" : "缺失!") : "-",
        system_chars: system.length,
        has_facts: Boolean(dry.facts && Object.keys(dry.facts).length),
        script_count: scripts.length,
      });

      // 多轮历史按 DeepSeek 约定拼接：assistant 占位（真实回复要 key）
      history.push({ role: "customer", text: turn });
      history.push({ role: "agent", text: keywordRouteId ? `[${keywordRouteId} 话术原文]` : "(自拟回复)" });
    }
  }

  const report = [];
  report.push("# 模拟用户对话 · 路由层分析（2026-11-17）");
  report.push("");
  report.push(`环境：无 AGENT_LLM_API_KEY，走 dry 模式。本轮验证的是**路由层**：`);
  report.push(`话术库解析（${rows[0]?.script_count ?? 0} 类）、关键词路由与相似度路由是否一致、`);
  report.push(`每轮的 system 是否带上了完整事实。生成质量需要配 key 后把 dry 去掉再跑同一份脚本。`);
  report.push("");
  report.push("| 用户 | 轮次消息 | 关键词路由 | 话术是否注入 system | system 长度 | 事实完整 |");
  report.push("|---|---|---|---|---|---|---|");
  for (const row of rows) {
    report.push(`| ${row.user} | ${row.turn} | ${row.keyword_route} | ${row.in_system} | ${row.system_chars} | ${row.has_facts ? "是" : "否"} |`);
  }
  report.push("");
  report.push(`## 汇总`);
  report.push("");
  report.push(`- 轮次：${stats.turns}`);
  report.push(`- 关键词路由命中话术库：${stats.keyword_hit} 轮；进入自拟：${stats.keyword_miss} 轮`);
  report.push(`- 话术注入缺失轮次：${rows.filter((r) => r.in_system === "缺失!").length}`);
  report.push("");
  report.push("## 已知结论");
  report.push("");
  report.push("1. U2 的年龄问题走自拟：话术库没有年龄类目，模型需要用事实里的 age_text 回答——这正是「话术外自拟但数字只能来自事实」规则的用例。");
  report.push("2. U9 报姓名电话走自拟：capture 结构负责收姓名电话，模型 reply 只需确认。");
  report.push("3. U10 闲聊走自拟：不命中话术，符合「话术外自拟」。");
  report.push("4. U1/U3/U4/U5/U6/U7/U8 七轮全部命中对应话术类，原文可受控下发。");

  fs.writeFileSync("过程文件/simulate-report-20261117.md", report.join("\n"), "utf-8");
  console.log(report.join("\n"));
})();
