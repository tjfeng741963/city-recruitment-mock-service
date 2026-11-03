// 备份 SQLite 并校验结果。
//
// 为什么不用 node:sqlite 的 backup()：实测在容器里跑出过只有 100 字节文件头、
// 0 页、sqlite_master 为空的空壳文件，而 PRAGMA integrity_check 对空库仍然返回 ok。
// 部署脚本据此以为备份成功，实际上没有任何东西被保护。
//
// VACUUM INTO 是单文件原子写出：不带 journal、不做增量，产出的就是一个完整可用的库。
//
// 用法：node backup-sqlite.mjs <源库> <目标备份>
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync, unlinkSync } from "node:fs";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
  console.error("usage: backup-sqlite.mjs <src> <dst>");
  process.exit(2);
}
if (!existsSync(src)) {
  console.error(`source not found: ${src}`);
  process.exit(2);
}
// VACUUM INTO 要求目标不存在
if (existsSync(dst)) unlinkSync(dst);

const db = new DatabaseSync(src, { readOnly: true });
let expected;
try {
  expected = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const check = new DatabaseSync(dst, { readOnly: true });
let actual, integrity, pages;
try {
  actual = check.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get().c;
  integrity = check.prepare("PRAGMA integrity_check").get().integrity_check;
  pages = check.prepare("PRAGMA page_count").get().page_count;
} finally {
  check.close();
}

const size = statSync(dst).size;
const ok = actual === expected && actual > 0 && integrity === "ok" && pages > 0;

console.log(JSON.stringify({ dst, size, pages, integrity, tables: actual, expected, ok }));

if (!ok) {
  console.error(
    `backup verification failed: tables=${actual}/${expected} pages=${pages} integrity=${integrity}`,
  );
  process.exit(1);
}
