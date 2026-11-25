import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { prepareFavoriteTitles, previewFavoriteLocation } from "../src/shared/favorite-location.js";
import { loadPositionLocationCards, parseLocationCardLabels } from "../src/shared/location-card.js";

/**
 * 企微原生位置卡（迁移 061）契约回归。
 *
 * 真实字节是 353 字节的 Boost serialization 包 protobuf（134 上采集的），
 * 这里用等价形状的假数据：控制字节分隔的中文串，足够覆盖「解析名称/地址」
 * 和「按 sha 去重」两条逻辑。发送链路不在这里测（在客户端）。
 */

/** 造一块像位置卡的字节：地址 + 名称，用 \0 分隔（解析器按控制字符切段）。 */
function cardBytes(address = "广东省深圳市龙华区民治街道龙屋工业区7栋", name = "广汽本田龙华店"): Buffer {
  return Buffer.concat([
    Buffer.from("22 serialization::archive 19 0 0 1 0 311 ", "latin1"),
    Buffer.from(address, "utf8"),
    Buffer.from([0x00, 0x08]),
    Buffer.from(name, "utf8"),
    Buffer.from([0x00, 0x01]),
  ]);
}

describe("location cards", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    // 设备必须先存在且启用，pair 才会发令牌（isValidDeviceToken 也要求这一行）
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('位置卡测试设备','enabled',?)")
      .run(JSON.stringify({ device_code: "local-device-001" }));
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterAll(async () => {
    await app?.close();
  });

  const capture = (bytes: Buffer, headers: Record<string, string> = device) =>
    app.inject({
      method: "POST", url: "/api/v1/agent/location-card", headers,
      payload: { data_base64: bytes.toString("base64") },
    });

  it("parses name and address out of the clipboard bytes", () => {
    const labels = parseLocationCardLabels(cardBytes());
    expect(labels.address).toBe("广东省深圳市龙华区民治街道龙屋工业区7栋");
    expect(labels.name).toBe("广汽本田龙华店");
  });

  it("captures once and treats the same bytes as a duplicate", async () => {
    const bytes = cardBytes();
    const first = await capture(bytes);
    expect(first.statusCode).toBe(200);
    expect(first.json().duplicate).toBe(false);
    expect(first.json().bytes).toBe(bytes.length);
    expect(first.json().name).toBe("广汽本田龙华店");

    const again = await capture(bytes);
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    expect(again.json().sha256).toBe(first.json().sha256);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM location_cards").get()).toMatchObject({ n: 1 });
  });

  it("rejects bad base64, oversized payloads and anonymous callers", async () => {
    expect((await app.inject({
      method: "POST", url: "/api/v1/agent/location-card", headers: device,
      payload: { data_base64: "不是 base64!!" },
    })).statusCode).toBe(422);
    expect((await app.inject({
      method: "POST", url: "/api/v1/agent/location-card", headers: device,
      payload: { data_base64: Buffer.alloc(9000, 7).toString("base64") },
    })).statusCode).toBe(422);
    expect((await app.inject({
      method: "POST", url: "/api/v1/agent/location-card",
      payload: { data_base64: cardBytes().toString("base64") },
    })).statusCode).toBe(403);
  });

  it("lists cards for the console but never returns the blob there", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/location-cards", headers: admin });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty("sha256");
    expect(items[0]).not.toHaveProperty("blob_b64");
    // 设备令牌不是用户 JWT，后台列表直接 401（全局鉴权先拦）
    expect((await app.inject({ method: "GET", url: "/api/v1/location-cards", headers: device })).statusCode).toBe(401);
  });

  it("syncs an account-scoped favorite snapshot and only reconciles complete snapshots", async () => {
    app.db.prepare("UPDATE bridge_devices SET account_id='douh' WHERE device_code='local-device-001'").run();
    const bytes = cardBytes("广东省广州市天河区车陂路48号3栋2楼201号", "冠宇商务中心");
    const captured = await app.inject({
      method: "POST", url: "/api/v1/agent/location-card", headers: device,
      payload: { data_base64: bytes.toString("base64"), account_id: "douh", favorite_id: "fav-guanyu" },
    });
    const sha = captured.json().sha256 as string;
    const first = await app.inject({
      method: "POST", url: "/api/v1/agent/location-favorites/sync", headers: device,
      payload: { account_id: "douh", snapshot_id: "s1", complete: false, items: [
        { favorite_id: "fav-guanyu", kind: "location", title: "冠宇商务中心", address: "广东省广州市天河区车陂路48号", location_card_sha: sha },
        { favorite_id: "fav-other", kind: "other", title: "一张文件" },
      ] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toBe(2);
    const incomplete = await app.inject({ method: "POST", url: "/api/v1/agent/location-favorites/sync", headers: device,
      payload: { account_id: "douh", snapshot_id: "s2", complete: false, items: [{ favorite_id: "fav-guanyu", kind: "location", title: "冠宇商务中心" }] } });
    expect(incomplete.statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM location_favorites WHERE account_id='douh'").get()).toMatchObject({ n: 2 });
    const complete = await app.inject({ method: "POST", url: "/api/v1/agent/location-favorites/sync", headers: device,
      payload: { account_id: "douh", snapshot_id: "s3", complete: true, items: [{ favorite_id: "fav-guanyu", kind: "location", title: "冠宇商务中心", location_card_sha: sha }] } });
    expect(complete.statusCode).toBe(200);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM location_favorites WHERE account_id='douh'").get()).toMatchObject({ n: 1 });
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/location-favorites/sync", headers: device,
      payload: { account_id: "other-account", snapshot_id: "s4", complete: true, items: [] } })).statusCode).toBe(409);
    const filtered = await app.inject({ method: "GET", url: "/api/v1/location-cards?account_id=douh", headers: admin });
    expect(filtered.json().favorites).toHaveLength(1);
    expect(filtered.json().favorites[0]).toMatchObject({ title: "冠宇商务中心", location_card_sha: sha });
  });

  it("ships only the cards bound to the device's position", async () => {
    const bytes = cardBytes("广州市白云区机场路1号冠宇商务中心", "冠宇商务中心");
    const captured = await capture(bytes);
    const sha = captured.json().sha256 as string;

    const city = await app.inject({
      method: "POST", url: "/api/v1/cities", headers: admin,
      payload: { city_name: "位置卡测试城", interview: { time: "周一至周六", location: "测试招聘点" } },
    });
    const created = await app.inject({
      method: "POST", url: "/api/v1/service-positions", headers: admin,
      payload: {
        position_name: "位置卡测试岗位",
        city_id: city.json().id,
        interview_points: [{ name: "冠宇面试点", address: "广州市白云区机场路1号", location_card_sha: sha }],
      },
    });
    expect(created.statusCode).toBe(200);
    const positionId = Number(created.json().id ?? created.json().position_id);
    expect(positionId).toBeGreaterThan(0);

    const cards = loadPositionLocationCards(app.db, positionId);
    expect(cards).toHaveLength(1);
    expect(cards[0].sha256).toBe(sha);
    expect(Buffer.from(cards[0].blob_b64, "base64").equals(bytes)).toBe(true);

    // 没绑卡的岗位不下发任何卡
    const bare = await app.inject({
      method: "POST", url: "/api/v1/service-positions", headers: admin,
      payload: { position_name: "无卡岗位", city_id: city.json().id },
    });
    expect(loadPositionLocationCards(app.db, Number(bare.json().id ?? bare.json().position_id))).toEqual([]);
  });

  it("keeps a valid binding and drops a malformed sha when saving the position", () => {
    const sha = "a".repeat(64);
    const ok = { interview_points: [{ name: "点A", location_card_sha: sha }] };
    prepareFavoriteTitles(ok);
    expect(ok.interview_points[0]).toMatchObject({ name: "点A", location_card_sha: sha });

    const bad = { interview_points: [{ name: "点B", location_card_sha: "not-a-sha" }] };
    prepareFavoriteTitles(bad);
    expect(bad.interview_points[0]).not.toHaveProperty("location_card_sha");
  });

  it("reports ready when the point has a card and stays unconfigured without one", () => {
    const withCard = previewFavoriteLocation("发个定位", [{ name: "冠宇", location_card_sha: "b".repeat(64) }], true);
    expect(withCard).toMatchObject({ status: "ready", point_name: "冠宇", card_sha: "b".repeat(64) });

    const titleOnly = previewFavoriteLocation("发个定位", [{ name: "冠宇", favorite_title: "冠宇商务中心" }], true);
    expect(titleOnly).toMatchObject({ status: "windows_unavailable" });
  });

  it("accepts a location opening as the last item and rejects one without coordinates", async () => {
    const city = await app.inject({
      method: "POST", url: "/api/v1/cities", headers: admin,
      payload: { city_name: "开场位置卡城", interview: { time: "周一至周六", location: "测试招聘点" } },
    });
    const position = await app.inject({
      method: "POST", url: "/api/v1/service-positions", headers: admin,
      payload: { position_name: "开场位置卡岗位", city_id: city.json().id },
    });
    const positionId = Number(position.json().id ?? position.json().position_id);

    const card = { lng: 113.39114, lat: 23.117692, address: "广东省广州市天河区车陂路438号3栋2楼201号", name: "冠宇商务中心" };
    const created = await app.inject({
      method: "POST", url: "/api/v1/agent-opening", headers: admin,
      payload: { position_id: positionId, kind: "location", content: JSON.stringify(card), delay_ms: 2000 },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ kind: "location", location: card });

    const missingCoord = await app.inject({
      method: "POST", url: "/api/v1/agent-opening", headers: admin,
      payload: { position_id: positionId, kind: "location", content: JSON.stringify({ address: "只有地址" }) },
    });
    expect(missingCoord.statusCode).toBe(422);

    // 列表里也必须带出解析好的 location，前端才画得出地图预览
    const list = await app.inject({ method: "GET", url: `/api/v1/agent-persona?position_id=${positionId}`, headers: admin });
    const items = list.json().openings as Array<Record<string, unknown>>;
    expect(items.some((item) => item.kind === "location" && (item.location as Record<string, unknown>)?.name === "冠宇商务中心")).toBe(true);
  });
});

describe("opening location card reaches the client", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let device: Record<string, string>;
  let positionId: number;

  const card = { lng: 113.39114, lat: 23.117692, address: "广东省广州市天河区车陂路438号3栋2楼201号", name: "冠宇商务中心" };

  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    app.db.prepare("INSERT INTO agent_devices(device_name,status,data_json) VALUES ('开场位置卡设备','enabled',?)")
      .run(JSON.stringify({ device_code: "local-device-001" }));
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };

    const city = await app.inject({
      method: "POST", url: "/api/v1/cities", headers: admin,
      payload: { city_name: "开场下发城", interview: { time: "周一至周六", location: "测试招聘点" } },
    });
    const position = await app.inject({
      method: "POST", url: "/api/v1/service-positions", headers: admin,
      payload: { position_name: "开场下发岗位", city_id: city.json().id },
    });
    positionId = Number(position.json().id ?? position.json().position_id);
    app.db.prepare("UPDATE agent_devices SET data_json=? WHERE json_extract(data_json,'$.device_code')='local-device-001'")
      .run(JSON.stringify({ device_code: "local-device-001", position_id: positionId }));
    await app.inject({
      method: "POST", url: "/api/v1/agent-opening", headers: admin,
      payload: { position_id: positionId, kind: "location", content: JSON.stringify(card), delay_ms: 2000 },
    });
  });

  afterAll(async () => {
    await app?.close();
  });

  it("ships location coordinates to the client, not just the raw JSON", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/v1/agent/opening?device_code=local-device-001", headers: device,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    const loc = items.find((item) => item.kind === "location");
    expect(loc).toBeTruthy();
    // 客户端靠这四个值生成卡片；缺一个就会「缺坐标」跳过
    expect(loc?.location).toMatchObject(card);
  });
});
