import type { DatabaseSync } from "node:sqlite";

/**
 * 设备 → 工厂「多选」绑定的唯一读写入口。
 *
 * 契约（三端约定，docs/对齐-设备工厂绑定与资料导入.md 的延伸）：
 * - 存储：agent_devices.data_json.factory_ids = number[]（factories.id）；
 *   老字段 factory_name 保留不动，向后兼容。
 * - 空数组 / 字段缺失 = 不绑任何厂 → 所有消费方退回「按城市全量」的老逻辑。
 * - 脏数据一律「忽略而不是报错」：重复 id 去重、非整数丢弃、库里不存在的 id 丢弃。
 *
 * 抽成共享模块的原因：设备列表（4222 admin）、岗位/城市查询（8090 服务间）、
 * 配置下发（设备客户端）三处读的是同一份 data_json，容错规则必须一致，
 * 否则「后台存得进、查询看不见」这类不一致最难查。
 */

export type DeviceFactory = { id: number; name: string; city_name: string };

/** data_json 容错解析：坏 JSON / 非对象一律当空对象，不抛。 */
export function parseDeviceData(raw: unknown): Record<string, unknown> {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * factory_ids 规范化：只收正整数，去重并保留首次出现顺序。
 * 允许 "12" 这种数字字符串（后台下拉框常直接提交 input 值），但小数/布尔/对象一律丢。
 */
export function parseFactoryIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const raw of value) {
    const id = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 丢掉库里不存在的 factory id（设备还绑着已删除的厂时不能让整单 422）。 */
export function existingFactoryIds(db: DatabaseSync, ids: number[]): number[] {
  if (!ids.length) return [];
  // id 列表只用于拼占位符，值仍走参数绑定，不做字符串拼接。
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id FROM factories WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: number }>;
  const known = new Set(rows.map((row) => Number(row.id)));
  return ids.filter((id) => known.has(id));
}

/** 原始值（多半来自 data_json.factory_ids）→ 可直接落库/可用于过滤的 id 数组。 */
export function readDeviceFactoryIds(db: DatabaseSync, value: unknown): number[] {
  return existingFactoryIds(db, parseFactoryIds(value));
}

/** 按 device_code 读设备绑定的工厂（设备不存在 = 空数组，不报错）。 */
export function deviceFactoryIds(db: DatabaseSync, deviceCode: string): number[] {
  const code = deviceCode.trim();
  if (!code) return [];
  const row = db.prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=?")
    .get(code) as { data_json: string } | undefined;
  if (!row) return [];
  return readDeviceFactoryIds(db, parseDeviceData(row.data_json).factory_ids);
}

/** 按 id 查厂名与所属城市；结果顺序跟随传入的 id 顺序，查不到的 id 直接跳过。 */
export function loadFactories(db: DatabaseSync, ids: number[]): DeviceFactory[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT f.id AS id, f.factory_name AS name, COALESCE(c.city_name,'') AS city_name
       FROM factories f
       LEFT JOIN cities c ON c.id = f.city_id
      WHERE f.id IN (${placeholders})`,
  ).all(...ids) as Array<{ id: number; name: string; city_name: string }>;
  const byId = new Map<number, DeviceFactory>(
    rows.map((row): [number, DeviceFactory] => [
      Number(row.id),
      { id: Number(row.id), name: String(row.name ?? ""), city_name: String(row.city_name ?? "") },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((row): row is DeviceFactory => Boolean(row));
}
