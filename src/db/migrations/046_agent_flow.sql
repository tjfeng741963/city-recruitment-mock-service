-- 节点工作流、会话游标与幂等发件箱（2026-11-19）。
--
-- flow/node/edge 是运营配置；conversation_state/outbox 是运行时状态。
-- phase 只表示流程位置，单条投递结果只放在 outbox.status，避免两套状态混用。

CREATE TABLE IF NOT EXISTS agent_flow (
  id INTEGER PRIMARY KEY,
  position_id INTEGER NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  canvas_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_flow_node (
  id INTEGER PRIMARY KEY,
  flow_id INTEGER NOT NULL,
  node_key TEXT NOT NULL,
  node_type TEXT NOT NULL DEFAULT 'text'
    CHECK (node_type IN ('text','image','video','followup','branch','end')),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  media_name TEXT NOT NULL DEFAULT '',
  parts_json TEXT NOT NULL DEFAULT '[]',
  delay_ms INTEGER NOT NULL DEFAULT 2000,
  await_reply INTEGER NOT NULL DEFAULT 0 CHECK (await_reply IN (0,1)),
  wait_minutes INTEGER NOT NULL DEFAULT 15,
  max_times INTEGER NOT NULL DEFAULT 1 CHECK (max_times BETWEEN 0 AND 3),
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(flow_id, node_key),
  FOREIGN KEY(flow_id) REFERENCES agent_flow(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_flow_node_flow ON agent_flow_node(flow_id, status);

CREATE TABLE IF NOT EXISTS agent_flow_edge (
  id INTEGER PRIMARY KEY,
  flow_id INTEGER NOT NULL,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL DEFAULT '',
  trigger TEXT NOT NULL DEFAULT 'default'
    CHECK (trigger IN ('default','any_reply','timeout','keyword','giveup')),
  condition_value TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  UNIQUE(flow_id, from_key, to_key, trigger),
  FOREIGN KEY(flow_id) REFERENCES agent_flow(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_flow_edge_from ON agent_flow_edge(flow_id, from_key, priority DESC);

CREATE TABLE IF NOT EXISTS agent_conversation_state (
  session_key TEXT NOT NULL,
  device_code TEXT NOT NULL DEFAULT '',
  position_id INTEGER NOT NULL DEFAULT 0,
  flow_version INTEGER NOT NULL DEFAULT 0,
  node_key TEXT NOT NULL DEFAULT '',
  step_index INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'idle'
    CHECK (phase IN ('idle','running','awaiting','followup_due','followup_sent','replied','expired','held')),
  await_since TEXT,
  followup_sent_at TEXT,
  followup_round INTEGER NOT NULL DEFAULT 0 CHECK (followup_round BETWEEN 0 AND 1),
  last_error TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  conv_name TEXT NOT NULL DEFAULT '',
  wait_minutes INTEGER NOT NULL DEFAULT 15,
  last_inbound_at REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(device_code, session_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_conv_state_device ON agent_conversation_state(device_code, phase);

CREATE TABLE IF NOT EXISTS agent_flow_outbox (
  id INTEGER PRIMARY KEY,
  session_key TEXT NOT NULL,
  node_key TEXT NOT NULL,
  part_index INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL DEFAULT '',
  media_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending','sent','failed','skipped','unknown')),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  UNIQUE(session_key, node_key, part_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_flow_outbox_session ON agent_flow_outbox(session_key, node_key, part_index);
