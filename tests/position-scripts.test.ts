import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * 按岗位配置话术（迁移 030）的四端契约回归：
 * - POST 是同 (position_id, stage) 覆盖，不是新增；
 * - GET ?position_id= 只回该岗位；
 * - /bridge/devices/:code/config 只下发绑定工厂的岗位话术；
 * - /agent/jobs 透出 media 且丢弃库里不存在的资源。
 *
 * 夹具（REA_SEED_FIXTURES=1）：岗位 1 = 本地示例岗位（工厂 1，广州），
 * 岗位 2 = 示例产线岗位（工厂 2，深圳）。
 */

// 1x1 透明 PNG：用真实图片字节，顺带验证 sha256 与 Content-Type
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("position scripts", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let svc: Record<string, string>;
  let mediaRoot = "";
  const saved = { ...process.env };

  beforeAll(async () => {
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rea-position-scripts-"));
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_MEDIA_DIR = mediaRoot;
    process.env.REA_PROFILE_TOKEN = "svc-profile-token";
    app = buildServer();
    await app.ready();
    const login = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    admin = { authorization: `Bearer ${login.json().access_token}` };
    svc = { "x-profile-token": "svc-profile-token" };
  });

  afterAll(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MEDIA_DIR", "REA_PROFILE_TOKEN"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    if (mediaRoot) fs.rmSync(mediaRoot, { recursive: true, force: true });
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/v1/position-scripts", headers: admin, payload });
  const upload = (name: string, kind = "image") =>
    app.inject({ method: "POST", url: "/api/v1/media", headers: admin, payload: { name, kind, data_base64: PNG_BASE64 } });
  const configOf = async (code: string) => {
    const pair = await app.inject({ method: "POST", url: `/api/v1/bridge/devices/${code}/pair`, headers: admin });
    expect(pair.statusCode).toBe(200);
    return app.inject({
      method: "GET", url: `/api/v1/bridge/devices/${code}/config`,
      headers: { authorization: `Bearer ${pair.json().device_token}` },
    });
  };

  

  

  

  it("exposes media on /agent/jobs and drops assets that do not exist", async () => {
    const uploaded = await upload("岗位图.png");
    const sha256 = uploaded.json().sha256 as string;
    app.db.prepare("UPDATE service_positions SET data_json=? WHERE id=1").run(JSON.stringify({
      media: [
        { name: "岗位图.png", kind: "image" },
        { name: "已删除的图.png", kind: "image" },
      ],
    }));

    const res = await app.inject({
      method: "GET", url: "/api/v1/agent/jobs?city=%E5%B9%BF%E5%B7%9E", headers: svc,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    const job = items.find((item) => item.position_id === 1);
    expect(job).toBeTruthy();
    expect(job?.media).toEqual([{ name: "岗位图.png", kind: "image", sha256 }]);

    // 没配媒体的岗位：空数组，绝不 undefined
    const other = items.find((item) => item.position_id !== 1);
    if (other) expect(other.media).toEqual([]);
  });
});
