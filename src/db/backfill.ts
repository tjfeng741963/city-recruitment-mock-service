import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

const BACKFILL_FILE = "024_kb_backfill_legacy.sql";

/**
 * 把存量 cities / factories / service_positions 回填进 v3 结构。
 *
 * 为什么不能只写在迁移里：迁移在 seedDatabase() 之前跑，全新库里
 * cities/factories 还是空的，回填插入 0 行；种子随后才写入。所以启动时
 * 再跑一次（幂等，全部 NOT EXISTS），新建的旧表数据也能被兜住。
 */
export function backfillLegacyKb(db: DatabaseSync): void {
  const file = path.resolve(process.cwd(), "src", "db", "migrations", BACKFILL_FILE);
  if (!fs.existsSync(file)) return;
  db.exec(fs.readFileSync(file, "utf8"));
}
