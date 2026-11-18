// 地铁 7 岗位同步到生产（119.91.113.100:4222）：岗位事实卡 + 开场序列 + 人设 + 媒体 + 设备改绑。
// 幂等：岗位按 position_name 查重，存在则跳过（不再重填开场）。
import fs from "node:fs";
import path from "node:path";

const BASE = "http://119.91.113.100:4222";
const login = await fetch(BASE + "/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "aadd8c44b2267288c0ae9a0f1018d1472525" }),
}).then((r) => r.json());
const auth = { authorization: "Bearer " + login.access_token, "content-type": "application/json" };

const j = async (method, p, body, headers = auth) => {
  const res = await fetch(BASE + p, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

// ── 本地数据 ──
const DatabaseSync = (await import("node:sqlite")).DatabaseSync;
const db = new DatabaseSync(path.resolve("data/app.sqlite"));
const positions = db.prepare("SELECT id, position_name, data_json FROM service_positions ORDER BY id").all();

// 生产映射（城市/工厂 id 来自生产库实测）
const PROD_CITY = { 深圳: 2, 广州: 1, 广东城际: 6, 佛山: 5, 南昌: 7, 南宁: 8 };
const PROD_FACTORY = {
  "深圳地铁安检基地": 14,
  "广州地铁安检基地（车陂南）": 10,
  "广东城际佛莞线基地（陈村）": 11,
  "广东城际穗深线基地（竹料）": 11,
  "佛山地铁安检基地": 12,
  "南昌地铁安检基地": 13,
  "南宁地铁安检基地": 15,
};

const idMap = {}; // 本地岗位 id → 生产岗位 id
for (const p of positions) {
  const data = JSON.parse(p.data_json || "{}");
  const cityId = PROD_CITY[data.city];
  const factoryId = PROD_FACTORY[data.factory_name];
  if (!cityId || !factoryId) {
    console.log(`跳过 ${p.position_name}（城市/工厂映射缺失）`);
    continue;
  }
  // 查重
  const existing = await j("GET", `/api/v1/service-positions?page=1&page_size=100`);
  let prodId = (existing.items || []).find((x) => x.position_name === p.position_name)?.id;
  if (!prodId) {
    const created = await j("POST", "/api/v1/service-positions", {
      city_id: cityId,
      factory_id: factoryId,
      position_name: p.position_name,
      ...data, // 事实卡字段全部进 data_json
    });
    prodId = created.id;
    console.log(`创建岗位 ${prodId} ${p.position_name}`);
  } else {
    // 更新事实卡
    await j("PUT", `/api/v1/service-positions/${prodId}`, {
      city_id: cityId, factory_id: factoryId, position_name: p.position_name, ...data,
    });
    console.log(`更新岗位 ${prodId} ${p.position_name}`);
  }
  idMap[p.id] = prodId;

  // 开场序列
  const openings = db.prepare("SELECT * FROM position_opening WHERE position_id=? AND status='enabled' ORDER BY seq, id").all(p.id);
  const existingOpening = await j("GET", `/api/v1/agent-opening?position_id=${prodId}`).catch(() => ({ items: [] }));
  const already = (existingOpening.items || existingOpening.opening || existingOpening.openings || []);
  if (already.length === 0 && openings.length) {
    for (const o of openings) {
      await j("POST", "/api/v1/agent-opening", {
        position_id: prodId,
        seq: Number(o.seq),
        kind: String(o.kind || "text"),
        content: String(o.content || ""),
        media_name: String(o.media_name || ""),
        status: "enabled",
      });
    }
    console.log(`  开场 ${openings.length} 条`);
  } else {
    console.log(`  开场已有 ${already.length} 条，跳过`);
  }

  // 人设
  const persona = db.prepare("SELECT content FROM agent_persona WHERE position_id=? AND status='enabled'").get(p.id);
  if (persona) {
    await j("PUT", "/api/v1/agent-persona", { position_id: prodId, content: persona.content, status: "enabled" });
    console.log(`  人设 ${persona.content.length} 字`);
  }
}

// ── 媒体上传（本地 data/media 哈希文件 → 生产，media_assets 名字带后缀）──
const medias = db.prepare("SELECT id, name, kind, storage_path, position_id FROM media_assets WHERE status='enabled'").all();
const prodMedia = await j("GET", "/api/v1/media").catch(() => ({ items: [] }));
for (const m of medias) {
  if ((prodMedia.items || []).some((x) => x.name === m.name)) {
    console.log(`媒体已存在: ${m.name}`);
    continue;
  }
  const buf = fs.readFileSync(path.resolve("data", m.storage_path));
  await j("POST", "/api/v1/media", {
    name: m.name,
    kind: m.kind,
    data_base64: buf.toString("base64"),
    position_id: m.position_id ? (idMap[m.position_id] || 0) : 0,
  });
  console.log(`上传媒体: ${m.name}（${buf.length} 字节，绑定岗位 ${m.position_id ? idMap[m.position_id] : "通用"}）`);
}

// ── 设备 pc-win-01 改绑生产的深圳岗位 ──
const devices = await j("GET", "/api/v1/agent/devices");
const device = (devices.items || []).find((d) => d.device_code === "pc-win-01");
const szLocal = positions.find((p) => p.position_name === "深圳_地铁安检员");
if (device && szLocal && idMap[szLocal.id]) {
  await j("PUT", `/api/v1/agent/devices/${device.id}`, { position_id: idMap[szLocal.id] });
  console.log(`pc-win-01 改绑生产岗位 ${idMap[szLocal.id]}（深圳_地铁安检员）`);
}

db.close();
console.log("同步完成。idMap:", JSON.stringify(idMap));
