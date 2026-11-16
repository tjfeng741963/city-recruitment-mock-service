#!/usr/bin/env node
// 迁移文件编号守卫。
//
// src/db/migrations/ 用「三位数字前缀」决定执行顺序与去重：同号迁移会被
// 迁移器静默跳过（历史上 029/031/033 各撞过一次，CI 从空库跑全绿，没人发现）。
// 这里把检查做成显式失败，避免靠人肉 `ls | sed | uniq -d`。
//
// 判定规则：
//   1. 编号重复            -> 失败（exitCode=1）
//   2. 文件名不合规        -> 失败（exitCode=1），防止 36_x.sql 这种两位编号排序错乱
//   3. 001 起编号有空洞    -> 仅告警（exitCode 不变），历史里可能存在有意跳号
//
// 用法：node scripts/check-migrations.mjs [--dir=路径]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME_RE = /^(\d{3})_[a-z0-9_]+\.sql$/;
const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrations");

function parseDir(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--dir=")) return path.resolve(arg.slice("--dir=".length));
    if (arg === "--dir") {
      const next = argv[i + 1];
      if (!next) {
        console.error("[migrations] --dir 缺少路径参数");
        process.exitCode = 1;
        return null;
      }
      return path.resolve(next);
    }
  }
  return DEFAULT_DIR;
}

function main() {
  const dir = parseDir(process.argv.slice(2));
  if (!dir) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    console.error(`[migrations] 无法读取目录 ${dir}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  // 迁移目录里只应存在迁移文件；隐藏文件（.gitkeep 等）跳过。
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();

  const invalid = [];
  const byNumber = new Map();

  for (const name of files) {
    const match = NAME_RE.exec(name);
    if (!match) {
      invalid.push(name);
      continue;
    }
    const number = match[1];
    const group = byNumber.get(number) ?? [];
    group.push(name);
    byNumber.set(number, group);
  }

  const duplicates = [...byNumber.entries()]
    .filter(([, names]) => names.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));

  // 断号：只对合规文件计算，区间为 001..最大编号。
  const numbers = [...byNumber.keys()].map((value) => Number.parseInt(value, 10)).sort((a, b) => a - b);
  const max = numbers.length > 0 ? numbers[numbers.length - 1] : 0;
  const seen = new Set(numbers);
  const gaps = [];
  for (let n = 1; n <= max; n += 1) {
    if (!seen.has(n)) gaps.push(String(n).padStart(3, "0"));
  }

  let failed = false;

  if (duplicates.length > 0) {
    failed = true;
    for (const [number, names] of duplicates) {
      console.error(`[migrations] 重复编号 ${number}: ${names.join(", ")}`);
    }
  }

  if (invalid.length > 0) {
    failed = true;
    for (const name of invalid) {
      console.error(`[migrations] 非法文件名 ${name}（应匹配 ^\\d{3}_[a-z0-9_]+\\.sql$，例如 001_init.sql）`);
    }
  }

  if (gaps.length > 0) {
    // 只告警：历史上可能存在有意跳号，不能因此让 CI 挂掉。
    console.log(`[migrations] 告警: 编号断号 ${gaps.join(", ")}（不影响退出码，请确认是否有意为之）`);
  }

  if (failed) {
    console.log(`[migrations] FAILED: ${files.length} files, ${duplicates.length} 个重复编号, ${invalid.length} 个非法文件名`);
    process.exitCode = 1;
    return;
  }

  const maxLabel = max > 0 ? String(max).padStart(3, "0") : "n/a";
  console.log(`[migrations] OK: ${files.length} files, max ${maxLabel}`);
}

main();
