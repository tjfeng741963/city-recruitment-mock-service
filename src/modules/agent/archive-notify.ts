import type { DatabaseSync } from "node:sqlite";

/**
 * 面试登记群通知的正文：**一条消息、一行字**。
 *
 *    张三 微信名称 13800138000 富士康 普工 11/24 09:00 龙华面试点
 *
 * 为什么是这个形状（2026-11-23 用户明确要求）：
 * - 群里认人靠「微信名称」，不是身份证姓名。姓名后面必须紧跟客户在企微里的
 *   昵称，否则群里不知道来的是谁；备注字段可以覆盖这个昵称。
 * - 一条消息发完，不再分「【面试登记】/时间/姓名/电话/客户/设备」多行——
 *   群消息越短越好核对，缺项直接省略，不留空标签。
 * - 工厂和岗位由 position_id 反查（service_positions → factories），
 *   不像以前那样只有姓名电话。
 *
 * 字段来源：
 *   name           agent_archive.name（模型 capture，缺了用客户原话兜底）
 *   remark         agent_archive.remark（运营填的，优先）
 *   nickname       agent_conversations.nickname（客户企微昵称，兜底）
 *   phone          agent_archive.phone
 *   factory/岗位   service_positions.position_name + factories.factory_name
 *   date/time      agent_archive.interview_date/time
 *   place          agent_archive.interview_address || interview_point
 */
export interface ArchiveNoticeInput {
  name: string;
  remark?: string;
  nickname?: string;
  phone: string;
  positionId?: number;
  interviewDate: string;
  interviewTime: string;
  place?: string;
}

/** "2026-11-24" → "11/24"；解析不了就原样返回。 */
export function monthDayOf(interviewDate: string): string {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(interviewDate ?? "").trim());
  return match ? `${Number(match[2])}/${Number(match[3])}` : String(interviewDate ?? "").trim();
}

/** 岗位 → 工厂名 / 岗位名 / 默认面试点；position_id 为 0 或查不到时都返回空串。 */
export function positionLabels(db: DatabaseSync, positionId: number): { factory: string; position: string; place: string } {
  if (!Number.isFinite(positionId) || positionId <= 0) return { factory: "", position: "", place: "" };
  const row = db
    .prepare(
      `SELECT sp.position_name AS position, sp.data_json AS data, f.factory_name AS factory
         FROM service_positions sp LEFT JOIN factories f ON f.id=sp.factory_id
        WHERE sp.id=?`,
    )
    .get(positionId) as { position?: string; factory?: string; data?: string } | undefined;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(String(row?.data ?? "") || "{}") as Record<string, unknown>;
  } catch {
    data = {};
  }
  // 面试点：配置了面试地址就直接用；只配了一个面试点就用它的名称。
  // 多个面试点时留空——客户没选，写哪个都可能是错的。
  const address = String(data.interview_address ?? "").trim();
  const points = Array.isArray(data.interview_points) ? data.interview_points : [];
  let place = address;
  if (!place && points.length === 1) {
    const only = points[0];
    place = typeof only === "string"
      ? String(only).trim()
      : String((only as Record<string, unknown>)?.name ?? "").trim();
  }
  return {
    factory: String(row?.factory ?? "").trim(),
    position: String(row?.position ?? "").trim(),
    place,
  };
}

export function buildArchiveNoticeLine(db: DatabaseSync, input: ArchiveNoticeInput): string {
  const { factory, position, place } = positionLabels(db, Number(input.positionId ?? 0));
  const raw = [
    String(input.name ?? "").trim() || "（待补）",
    // 备注优先，其次是客户企微昵称——两者都空时这一段自然消失
    String(input.remark ?? "").trim() || String(input.nickname ?? "").trim(),
    String(input.phone ?? "").trim(),
    factory,
    position,
    monthDayOf(input.interviewDate),
    String(input.interviewTime ?? "").trim(),
    // 登记里有的面试点优先（Dify 路径客户选过），否则用岗位配的默认面试点
    String(input.place ?? "").trim() || place,
  ];
  // 去重：厂名与岗位常常是「深圳地铁安检 安检员」这类包含关系，重复出现没意义
  const parts: string[] = [];
  for (const value of raw) {
    if (!value) continue;
    if (parts.includes(value)) continue;
    parts.push(value);
  }
  return parts.join(" ");
}
