import type { DatabaseSync } from "node:sqlite";

/**
 * Dify 使用 position_id 和 factory_ids 作为默认岗位与推荐范围。
 * Agent 使用 agent_position_id，缺少该字段的旧账号继承原岗位。
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
  return receptionFactoryIds(db, parseDeviceData(row.data_json));
}

export function receptionFactoryIds(
  db: DatabaseSync, data: Record<string, unknown>, provider = data.reply_provider,
): number[] {
  if (provider === "dify") return readDeviceFactoryIds(db, data.factory_ids);
  const positionId = resolveDevicePosition(db, data, provider);
  const position = db.prepare("SELECT factory_id FROM service_positions WHERE id=?").get(positionId) as
    { factory_id: number | null } | undefined;
  return position?.factory_id ? [position.factory_id] : [];
}

/**
 * Resolve the position for the requested source, or the source being applied by Windows.
 */
export function devicePositionId(db: DatabaseSync, deviceCode: string, provider?: "agent" | "dify"): number {
  const code = deviceCode.trim();
  if (!code) return 0;
  const row = db
    .prepare("SELECT data_json FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? AND status='enabled'")
    .get(code) as { data_json: string } | undefined;
  if (!row) return 0;
  const data = parseDeviceData(row.data_json);
  return resolveDevicePosition(db, data, provider ?? data.reply_provider);
}

export function resolveDevicePosition(db: DatabaseSync, data: Record<string, unknown>, provider: unknown): number {
  const raw = provider !== "dify" && Object.hasOwn(data, "agent_position_id")
    ? data.agent_position_id : data.position_id;
  const rawPositionId = typeof raw === "number" || typeof raw === "string"
    ? Number(raw)
    : 0;
  const storedPositionId = Number.isSafeInteger(rawPositionId) && rawPositionId > 0 ? rawPositionId : 0;
  if (provider !== "dify" && (storedPositionId || Object.hasOwn(data, "agent_position_id"))) {
    return storedPositionId;
  }
  const factoryIds = readDeviceFactoryIds(db, data.factory_ids);

  if (!factoryIds.length) return storedPositionId;
  if (storedPositionId > 0) {
    const stored = db
      .prepare("SELECT factory_id FROM service_positions WHERE id=? AND status='enabled'")
      .get(storedPositionId) as { factory_id: number | null } | undefined;
    if (stored && (stored.factory_id === null || factoryIds.includes(Number(stored.factory_id)))) {
      return storedPositionId;
    }
  }

  const placeholders = factoryIds.map(() => "?").join(",");
  const replacement = db
    .prepare(`SELECT id FROM service_positions WHERE status='enabled' AND factory_id IN (${placeholders}) ORDER BY id LIMIT 1`)
    .get(...factoryIds) as { id: number } | undefined;
  return Number(replacement?.id ?? 0);
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
