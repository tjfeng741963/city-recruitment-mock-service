import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { seedDatabase } from "../src/db/seed.js";
import { parsePagination } from "../src/shared/pagination.js";

describe("SQLite migrations and seed", () => {
  it("creates every module table and seeds idempotently", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    expect(before.map((row) => row.name)).toEqual(expect.arrayContaining([
      "users", "cities", "factories", "service_positions", "knowledge_items", "activation_strategies",
      "jobs", "job_attempts", "job_locks", "user_scope_assignments", "admin_audit_logs",
    ]));
    seedDatabase(db);
    const first = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    seedDatabase(db);
    const second = (db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count;
    expect(first).toBeGreaterThanOrEqual(3);
    expect(second).toBe(first);
  });

  it("adds the candidate profile columns and stays idempotent across restarts", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    migrateDatabase(db); // 老库升级/进程重启后再跑一遍不能炸（016 由 schema_migrations 记录跳过）
    seedDatabase(db);
    const columns = (db.prepare("PRAGMA table_info(agent_conversations)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["name", "phone", "remark", "factory_name", "interview_date", "interview_time", "profile_json"]));
    const row = db.prepare("SELECT * FROM agent_conversations WHERE device_code='local-device-001' AND customer_id=700001").get() as Record<string, unknown>;
    expect(row).toMatchObject({ name: "", phone: "", remark: "", factory_name: "", interview_date: "", interview_time: "", profile_json: "{}" });
    db.close();
  });

  it("keeps user scopes unique and preserves audit history after account deletion", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    seedDatabase(db);
    const userId = Number((db.prepare("SELECT id FROM users WHERE username='local-customer'").get() as { id: number }).id);
    db.prepare("INSERT INTO user_scope_assignments(user_id,scope_type,scope_id) VALUES (?,?,?)").run(userId, "device", "device-a");
    expect(() => db.prepare("INSERT INTO user_scope_assignments(user_id,scope_type,scope_id) VALUES (?,?,?)").run(userId, "device", "device-a")).toThrow();
    db.prepare("INSERT INTO admin_audit_logs(actor_user_id,action,resource_type,resource_id,summary_json) VALUES (?,?,?,?,?)").run(userId, "user.disabled", "user", String(userId), JSON.stringify({ fields: ["is_active"] }));
    db.prepare("DELETE FROM users WHERE id=?").run(userId);
    expect(db.prepare("SELECT COUNT(*) count FROM user_scope_assignments WHERE user_id=?").get(userId)).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM admin_audit_logs WHERE resource_id=?").get(String(userId))).toMatchObject({ count: 1 });
    db.close();
  });
});

describe("parsePagination", () => {
  it("uses target page and page_size names and clamps unsafe values", () => {
    expect(parsePagination({ page: "2", page_size: "100" })).toEqual({ page: 2, pageSize: 100, offset: 100 });
    expect(parsePagination({ page: "0", page_size: "-5" })).toEqual({ page: 1, pageSize: 20, offset: 0 });
  });
});
