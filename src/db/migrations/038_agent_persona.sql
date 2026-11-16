-- 人设与开场（2026-11-16）。
--
-- 背景：旧链路把「开场说什么」分散在 position_scripts（5 个时点）、
-- device_scripts（设备 + 城市）、flow_nodes.body（节点正文）和 flow_engine 的
-- 硬编码默认话术里，同一个意思有七个定义处。重构后只保留两层：
--   1. 开场：客户加好友后按序播一遍，条目可以是文本 / 图片 / 视频；
--   2. 会话：播完交给 Agent，人设来自本表。
--
-- 设备通过 agent_devices.data_json.position_id 找到岗位，再找到人设与开场，
-- 所以这里只挂岗位，不挂设备：换设备复用同一份，换岗位自动跟着换。
--
-- opening_log 只记录、不驱动流程：客户端靠发送回执推进，失败条目跳过，
-- 事后能查「这台设备给这个客户的开场，哪一条没发出去」。

-- ── 1. 人设：一个岗位一份 ────────────────────────────────────────
-- position_id UNIQUE 是硬约束：一个岗位只能有一份人设，避免「改了 A 设备的
-- 人设，B 设备还是旧人设」这种分裂。设备想用不同语气，就绑不同岗位。
CREATE TABLE IF NOT EXISTS agent_persona (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_persona_position
  ON agent_persona(position_id, status);

-- ── 2. 开场条目：有序、可多模态 ──────────────────────────────────
-- seq 不加唯一约束：运营调整顺序时先改 seq 再落库，唯一约束会在中间态报冲突。
-- 排序一律按 (seq, id)，id 兜底保证并发插入也不会乱。
--
-- delay_ms 是「这一条发完之后至少等多久」，服务端下限 2000ms，由路由校验；
-- 客户端还要额外满足「上一条回读成功」才推进，两个条件是并且关系。
CREATE TABLE IF NOT EXISTS position_opening (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  media_name TEXT NOT NULL DEFAULT '',
  delay_ms INTEGER NOT NULL DEFAULT 2000,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind IN ('text', 'image', 'video')),
  CHECK (status IN ('enabled', 'disabled')),
  CHECK (delay_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_position_opening_order
  ON position_opening(position_id, status, seq, id);

-- ── 3. 开场执行记录 ─────────────────────────────────────────────
-- session_key 是企微会话 id（客户端传来，最长 64），一次开场每个条目一行。
-- 只写不等：客户端发完一条异步上报，失败也上报，方便运营排查「图没发出去」。
CREATE TABLE IF NOT EXISTS opening_log (
  id INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  device_code TEXT NOT NULL DEFAULT '',
  position_id INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('pending', 'sent', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_opening_log_session
  ON opening_log(session_key, created_at);
CREATE INDEX IF NOT EXISTS idx_opening_log_position
  ON opening_log(position_id, created_at);
