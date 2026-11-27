/**
 * 入站消息落库（2026-11-17 从 message-automation.ts 抽出）。
 *
 * Dify 自动回复链路下线后，AI 生成的部分归新 Agent 链路
 * （autopilot → /agent/chat）；这里只保留「存储」这一半：
 * 把客户消息写进 agent_messages 并滚动会话摘要（last_msg / unread），
 * 供会话页与 SSE 快照读取。
 */
import type { DatabaseSync } from "node:sqlite";

export interface InboundMessageInput {
  deviceCode: string;
  customerId: number;
  content: string;
  sentAt?: string;
  eventId: string;
}

export function recordInboundMessage(
  db: DatabaseSync,
  input: InboundMessageInput,
): { created: boolean } {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const tenant = db.prepare("SELECT tenant_id FROM agent_conversations WHERE device_code=? AND customer_id=?")
    .get(input.deviceCode,input.customerId)?.tenant_id ?? 1;
  const inserted = db
    .prepare(
      "INSERT OR IGNORE INTO agent_messages(device_code,customer_id,direction,content,status,created_at,source_event_id,tenant_id) VALUES (?,?, 'inbound',?,'received',?,?,?)",
    )
    .run(input.deviceCode, input.customerId, input.content, input.sentAt ?? now, input.eventId, tenant);
  if (Number(inserted.changes) !== 1) return { created: false };

  db.prepare(
    `INSERT INTO agent_conversations(device_code,customer_id,last_msg,last_msg_at,unread,updated_at)
     VALUES (?,?,?,?,1,?)
     ON CONFLICT(device_code,customer_id) DO UPDATE SET
       last_msg=CASE WHEN agent_conversations.last_msg_at IS NULL OR julianday(agent_conversations.last_msg_at)<=julianday(excluded.last_msg_at) THEN excluded.last_msg ELSE agent_conversations.last_msg END,
       last_msg_at=CASE WHEN agent_conversations.last_msg_at IS NULL OR julianday(agent_conversations.last_msg_at)<=julianday(excluded.last_msg_at) THEN excluded.last_msg_at ELSE agent_conversations.last_msg_at END,
       unread=agent_conversations.unread+1,updated_at=excluded.updated_at`,
  ).run(input.deviceCode, input.customerId, input.content, input.sentAt ?? now, now);

  return { created: true };
}
