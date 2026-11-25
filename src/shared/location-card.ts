import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * 企微原生位置卡的剪贴板字节（2026-11-25）。
 *
 * 实测结论（134 上逐字节核对过）：
 * - 企微 PC 没有「发送位置」入口，也不能凭空构造位置消息；
 * - 右键任意位置消息 →「复制」，剪贴板里会多一个自定义格式 `WeWork Message`；
 * - 该格式 353 字节，是 Boost serialization 包 protobuf，里面能直接读出
 *   经度/纬度（IEEE-754 double）、名称、地址（UTF-8 字符串）；
 * - 把这块字节用 SetClipboardData 写回剪贴板，再在目标会话 Ctrl+V，
 *   粘出来的就是同一张原生卡（不需要收藏、不需要转发、不需要点菜单）。
 *
 * 因此服务端只负责「存字节 + 按 sha 下发」，解析名称/地址只用于后台列表
 * 显示与人工辨认，**不参与发送**——解析失败也不影响发卡。
 */

/** 实测 353 字节；给到 8KB 是为了容纳地址更长、带备注的卡。 */
export const LOCATION_CARD_MAX_BYTES = 8 * 1024;

export const LOCATION_CARD_BAD_BASE64 = "位置卡数据不是合法的 base64";
export const LOCATION_CARD_TOO_LARGE = "位置卡数据超过 8KB，不是企微位置消息";

export type LocationCardBytes = { ok: true; bytes: Buffer } | { ok: false; detail: string };

/** base64 容错解析：允许 data URL 前缀与换行，先按长度估算再解码。 */
export function decodeLocationCard(raw: unknown): LocationCardBytes {
  if (typeof raw !== "string") return { ok: false, detail: LOCATION_CARD_BAD_BASE64 };
  const comma = raw.indexOf(",");
  const body = raw.startsWith("data:") && comma > 0 ? raw.slice(comma + 1) : raw;
  const cleaned = body.replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return { ok: false, detail: LOCATION_CARD_BAD_BASE64 };
  const estimated = Math.floor((cleaned.length * 3) / 4);
  if (estimated > LOCATION_CARD_MAX_BYTES) return { ok: false, detail: LOCATION_CARD_TOO_LARGE };
  const bytes = Buffer.from(cleaned, "base64");
  if (!bytes.length) return { ok: false, detail: LOCATION_CARD_BAD_BASE64 };
  if (bytes.length > LOCATION_CARD_MAX_BYTES) return { ok: false, detail: LOCATION_CARD_TOO_LARGE };
  return { ok: true, bytes };
}

export function locationCardSha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha 只接受 64 位小写 hex（库里就是这么存的，别让别的形状混进来）。 */
export function isLocationCardSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** 下发给客户端的卡片：只有绑在面试点上的才会发。 */
export type LocationCardPayload = { sha256: string; name: string; address: string; blob_b64: string };

/**
 * 取某个岗位绑定的位置卡（随设备配置下发）。
 *
 * 绑定关系存在 `service_positions.data_json.interview_points[].location_card_sha`，
 * 字节本体在 location_cards 表——这样一张卡可以被多个面试点共用，
 * 面试点数据里也不会塞进几百字节的 base64。
 */
export function loadPositionLocationCards(db: DatabaseSync, positionId: number): LocationCardPayload[] {
  if (!positionId) return [];
  const row = db.prepare("SELECT data_json FROM service_positions WHERE id=?").get(positionId) as
    | { data_json: string }
    | undefined;
  if (!row) return [];
  let points: unknown;
  try {
    const parsed = JSON.parse(row.data_json || "{}") as Record<string, unknown>;
    points = parsed.interview_points;
  } catch {
    return [];
  }
  if (!Array.isArray(points)) return [];
  const shas = [...new Set(points.flatMap((point) => {
    if (!point || typeof point !== "object") return [];
    const sha = (point as Record<string, unknown>).location_card_sha;
    return isLocationCardSha(sha) ? [sha] : [];
  }))];
  if (!shas.length) return [];
  const placeholders = shas.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT sha256,name,address,blob_b64 FROM location_cards WHERE sha256 IN (${placeholders})`,
  ).all(...shas) as Array<{ sha256: string; name: string; address: string; blob_b64: string }>;
  return rows.map((card) => ({
    sha256: String(card.sha256),
    name: String(card.name ?? ""),
    address: String(card.address ?? ""),
    blob_b64: String(card.blob_b64 ?? ""),
  }));
}

/** 序列化头里的 ASCII 噪声（"22 serialization::archive 19 0 0 1 0 311"）。 */
const NOISE = /^(?:\d+\s+)?serialization::archive|^\d+\s+\d+\s+\d+|^[A-Za-z0-9+/=]{8,}$/;

const CJK = /[\u3400-\u9fff]/;
const ADDRESS_HINT = /[省市区县路街号栋楼室巷村镇]/;

/**
 * 从字节里尽力抠出名称和地址。
 *
 * 做法：整块按 UTF-8 解一遍（坏字节变 U+FFFD），再按控制字符/替换字符切段，
 * 只保留含中文、长度 2~60 的段。地址取含「省市区路街号」的最长一段，
 * 名称取剩下的最长一段。**纯展示用**，抠错了不影响发卡。
 */
export function parseLocationCardLabels(bytes: Buffer): { name: string; address: string } {
  const text = bytes.toString("utf8");
  // 按「中英文数字 + 地址常用符号」连续段切；二进制/控制字节天然不在这个集合里，
  // 所以地址和名称会被切成两段，而序列化头（"22 serialization::archive …"）里
  // 没有中文，会被下面的 CJK 过滤掉。
  const runs = text.match(/[\u3400-\u9fff0-9A-Za-z()（）#·\-]{2,60}/g) ?? [];
  const unique: string[] = [];
  for (const run of runs) {
    const segment = run.trim();
    if (segment.length < 2 || !CJK.test(segment) || NOISE.test(segment)) continue;
    if (!unique.includes(segment)) unique.push(segment);
  }
  if (!unique.length) return { name: "", address: "" };

  const address = unique
    .filter((segment) => ADDRESS_HINT.test(segment))
    .sort((a, b) => b.length - a.length)[0] ?? "";
  const name = unique
    .filter((segment) => segment !== address)
    .sort((a, b) => b.length - a.length)[0] ?? "";
  return { name, address };
}
