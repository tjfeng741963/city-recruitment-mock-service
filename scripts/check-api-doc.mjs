#!/usr/bin/env node
// 接口文档守卫。
//
// 人设 / 开场 / Agent 会话这三组接口刚上线，最容易发生的是「代码加了接口、
// docs/API-接口清单.md 忘了写」，下一个接手的人只能去翻 TypeScript。
// 这里把文档里标记区块的接口和代码里实际注册的路由做双向比对：
//   - 代码有、文档没有  -> 失败（漏写）
//   - 文档有、代码没有  -> 失败（写错或已删未清理）
//
// 只校验 agent-persona.routes.ts / agent-chat.routes.ts。知识库那批是存量接口，
// 历史上就没有完整清单，硬校验只会让 CI 常年红。
//
// 用法：node scripts/check-api-doc.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = path.join(ROOT, "docs", "API-接口清单.md");
const CODE_FILES = [
  path.join(ROOT, "src", "modules", "agent", "agent-persona.routes.ts"),
  path.join(ROOT, "src", "modules", "agent", "agent-chat.routes.ts"),
];
const START = "<!-- api-check:start -->";
const END = "<!-- api-check:end -->";

function fail(lines) {
  for (const line of lines) console.error(`[api-doc] ${line}`);
  console.error("[api-doc] FAILED");
  process.exitCode = 1;
}

function readDocRoutes() {
  if (!fs.existsSync(DOC)) throw new Error(`找不到文档：${DOC}`);
  const raw = fs.readFileSync(DOC, "utf8");
  const routes = new Set();
  let cursor = 0;
  while (true) {
    const start = raw.indexOf(START, cursor);
    if (start < 0) break;
    const end = raw.indexOf(END, start);
    if (end < 0) throw new Error("api-check 区块没有收尾标记");
    const block = raw.slice(start + START.length, end);
    // | GET | `/api/v1/agent/chat` | admin | ... |
    const rowRe = /^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`([^`]+)`/gm;
    let match = rowRe.exec(block);
    while (match) {
      const method = match[1].toUpperCase();
      // query string 在路由上不存在，比对时截掉
      const route = match[2].split("?")[0].trim();
      routes.add(`${method} ${route}`);
      match = rowRe.exec(block);
    }
    cursor = end + END.length;
  }
  return routes;
}

function readCodeRoutes() {
  const routes = new Set();
  for (const file of CODE_FILES) {
    if (!fs.existsSync(file)) throw new Error(`找不到路由文件：${file}`);
    const text = fs.readFileSync(file, "utf8");
    // 泛型可能跨行，所以先定位 app.<method>，再在后面的窗口里找第一个 /api 字面量。
    const callRe = /app\.(get|post|put|delete|patch)\b/g;
    let match = callRe.exec(text);
    while (match) {
      const window = text.slice(match.index, match.index + 600);
      const pathMatch = window.match(/"(\/api\/[^"]+)"/);
      if (pathMatch) routes.add(`${match[1].toUpperCase()} ${pathMatch[1]}`);
      match = callRe.exec(text);
    }
  }
  return routes;
}

function main() {
  let docRoutes;
  let codeRoutes;
  try {
    docRoutes = readDocRoutes();
    codeRoutes = readCodeRoutes();
  } catch (error) {
    fail([error.message]);
    return;
  }

  if (!docRoutes.size) {
    fail(["文档里没有解析到任何接口，检查 api-check 标记和表格格式"]);
    return;
  }

  const missingInDoc = [...codeRoutes].filter((route) => !docRoutes.has(route)).sort();
  const missingInCode = [...docRoutes].filter((route) => !codeRoutes.has(route)).sort();

  if (missingInDoc.length || missingInCode.length) {
    const lines = [`文档 ${docRoutes.size} 条，代码 ${codeRoutes.size} 条`];
    if (missingInDoc.length) {
      lines.push("代码里有、文档里没写：");
      for (const route of missingInDoc) lines.push(`  + ${route}`);
    }
    if (missingInCode.length) {
      lines.push("文档里写了、代码里没有：");
      for (const route of missingInCode) lines.push(`  - ${route}`);
    }
    lines.push("改接口请同步 docs/API-接口清单.md 的 api-check 区块");
    fail(lines);
    return;
  }

  console.log(`[api-doc] OK: 文档 ${docRoutes.size} 条，代码 ${codeRoutes.size} 条，一致`);
}

main();
