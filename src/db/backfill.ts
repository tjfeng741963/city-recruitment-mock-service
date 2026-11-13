import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// 放在 src/db/backfill/ 而不是 migrations/：migrations 里的文件会被
// migrateDatabase 在种子之前执行，而它要读 cities / factories，那时还是空的。
export const BACKFILL_FILES = [
  // 存量 cities / factories / service_positions → v3 结构
  "migrations/024_kb_backfill_legacy.sql",
  // 客户真实工厂岗位（6 家厂 / 11 个岗位 / 厂级问答 / 岗位级工价）
  "backfill/028_kb_real_factories.sql",
  // 客户真实地铁安检岗位（5 个城市 / 6 个面试点 / 面试点级问答）
  "backfill/029_kb_real_subway.sql",
] as const;

/** 执行单个回填文件。测试需要单独验证 024 / 028 时用这个。 */
export function applyBackfillFile(db: DatabaseSync, name: string): void {
  const file = path.resolve(process.cwd(), "src", "db", name);
  if (!fs.existsSync(file)) return;
  db.exec(fs.readFileSync(file, "utf8"));
}

/**
 * 把存量数据与客户真实岗位回填进 v3 结构。
 *
 * 为什么不能只写在迁移里：迁移在 seedDatabase() 之前跑，全新库里
 * cities/factories 还是空的，回填插入 0 行；种子随后才写入。所以启动时
 * 再跑一次（幂等，全部 NOT EXISTS），新建的旧表数据也能被兜住。
 */
export function backfillLegacyKb(db: DatabaseSync): void {
  for (const name of BACKFILL_FILES) applyBackfillFile(db, name);
}
