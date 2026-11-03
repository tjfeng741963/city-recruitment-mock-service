-- 多租户：租户表 + 所有业务表加 tenant_id
--
-- 阶段 1 的做法是"加列 + 回填默认租户"，**不在这里开 RLS**。
-- 单租户环境下 RLS 是过度设计，接第二个客户时（阶段 4）再补。
-- 但列必须先有——等有第二个客户再改 50 张表，返工量和风险都不可控。
--
-- DEFAULT 1 意味着现有代码一行不改也能跑：所有写入自动落到租户 1。
-- 查询端要按租户过滤，那是阶段 4 的事（届时漏写 WHERE 的兜底才是 RLS）。

CREATE TABLE tenant (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO tenant (id, name, slug) VALUES (1, '默认租户', 'default');

-- SQLite 限制：ALTER TABLE ADD COLUMN 不能同时带 REFERENCES 和 NOT NULL 默认值
-- （报 "Cannot add a REFERENCES column with non-NULL default value"）。
-- 因此这里只加列 + 默认值，外键约束由应用层与 tenant 表的唯一性保证；
-- 将来迁到 PostgreSQL 时再补真正的 FK（那时用独立 migration 加约束）。
ALTER TABLE users ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cities ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE factories ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE job_attempts ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE job_locks ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE knowledge_items ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recruiters ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recruiter_cities ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recruiter_featured ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE candidates ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE candidate_events ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_positions ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE service_position_holidays ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE holiday_schedules ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE city_links ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE city_history ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE status_records ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE unknown_questions ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE old_friends ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE old_friend_records ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE evaluation_runs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_scope_assignments ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admin_audit_logs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activation_config ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activation_devices ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activation_records ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activation_scripts ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activation_strategies ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activation_strategy_rules ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_configs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_conversations ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_devices ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_evaluations ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_messages ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_rules ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE conversations ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE webhook_logs ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE message_deliveries ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE message_events ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bridge_commands ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bridge_contacts ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bridge_devices ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bridge_inbound ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wecom_connections ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wecom_callback_events ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wecom_contacts ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wecom_inbox ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wecom_outbox ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1;

-- 高频查询路径的索引：租户 + 业务主键组合。
-- 只给最常用的几张建，其余等实际慢查询出现再加——现在建 50 个索引是浪费。
CREATE INDEX idx_cities_tenant ON cities(tenant_id);
CREATE INDEX idx_factories_tenant ON factories(tenant_id);
CREATE INDEX idx_jobs_tenant ON jobs(tenant_id);
CREATE INDEX idx_knowledge_items_tenant ON knowledge_items(tenant_id);
CREATE INDEX idx_candidates_tenant ON candidates(tenant_id);
CREATE INDEX idx_conversations_tenant ON conversations(tenant_id);
CREATE INDEX idx_users_tenant ON users(tenant_id);
