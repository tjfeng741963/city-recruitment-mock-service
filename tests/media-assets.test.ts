import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * 媒体资源库（迁移 031）契约回归：
 * - POST /api/v1/media 落盘到 <data>/media/<sha256>.<ext> 并入库；
 * - sha256 与文件字节一致；GET /api/v1/agent/media/:name 下载内容一致；
 * - 下载鉴权接受设备 token 或 X-Profile-Token；
 * - 同名重传是替换，不是报 409。
 */

// 1x1 透明 PNG
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BUFFER = Buffer.from(PNG_BASE64, "base64");
const PNG_SHA = createHash("sha256").update(PNG_BUFFER).digest("hex");

describe("media assets", () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let svc: Record<string, string>;
  let device: Record<string, string>;
  let mediaRoot = "";
  const saved = { ...process.env };

  beforeAll(async () => {
    mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rea-media-assets-"));
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
    const pair = await app.inject({ method: "POST", url: "/api/v1/bridge/devices/local-device-001/pair", headers: admin });
    device = { authorization: `Bearer ${pair.json().device_token}` };
  });

  afterAll(async () => {
    await app?.close();
    for (const key of ["REA_DATABASE_PATH", "REA_MEDIA_DIR", "REA_PROFILE_TOKEN"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    if (mediaRoot) fs.rmSync(mediaRoot, { recursive: true, force: true });
  });

  const upload = (name: string, kind = "image", data = PNG_BASE64) =>
    app.inject({ method: "POST", url: "/api/v1/media", headers: admin, payload: { name, kind, data_base64: data } });

  it("stores the file under media/<sha256>.<ext> with a matching checksum", async () => {
    const res = await upload("联测电子厂_门头.png");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ name: "联测电子厂_门头.png", kind: "image", sha256: PNG_SHA, bytes: PNG_BUFFER.length });

    const stored = path.join(mediaRoot, `${PNG_SHA}.png`);
    expect(fs.existsSync(stored)).toBe(true);
    expect(fs.readFileSync(stored).equals(PNG_BUFFER)).toBe(true);
    expect(app.db.prepare("SELECT storage_path FROM media_assets WHERE name=?").get("联测电子厂_门头.png"))
      .toMatchObject({ storage_path: `media/${PNG_SHA}.png` });

    // 同名重传 = 替换（name UNIQUE，不能 409，也不能多出一行）
    const again = await upload("联测电子厂_门头.png");
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(body.id);
    expect(app.db.prepare("SELECT COUNT(*) n FROM media_assets").get()).toMatchObject({ n: 1 });

    const listed = await app.inject({ method: "GET", url: "/api/v1/media", headers: admin });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toEqual([
      // position_id=0 通用池 / position_name=null 未绑定岗位（2026-11-17 媒体分层）
      { id: body.id, name: "联测电子厂_门头.png", kind: "image", sha256: PNG_SHA, bytes: PNG_BUFFER.length, position_id: 0, position_name: null },
    ]);
  });

  it('rejects binding an uploaded file to a nonexistent position', async () => {
    const res=await app.inject({method:'POST',url:'/api/v1/media',headers:admin,
      payload:{name:'invalid-job.png',kind:'image',data_base64:PNG_BASE64,position_id:999999}});
    expect(res.statusCode).toBe(422);
  });

  it("streams the exact bytes with sha256 and content-type headers", async () => {
    const byProfile = await app.inject({
      method: "GET", url: `/api/v1/agent/media/${encodeURIComponent("联测电子厂_门头.png")}`, headers: svc,
    });
    expect(byProfile.statusCode).toBe(200);
    expect(byProfile.headers["x-content-sha256"]).toBe(PNG_SHA);
    expect(String(byProfile.headers["content-type"])).toContain("image/png");
    expect(byProfile.rawPayload.equals(PNG_BUFFER)).toBe(true);

    // 设备 token 也能下载（客户端没有用户 JWT）
    const byDevice = await app.inject({
      method: "GET", url: `/api/v1/agent/media/${encodeURIComponent("联测电子厂_门头.png")}`, headers: device,
    });
    expect(byDevice.statusCode).toBe(200);
    expect(byDevice.rawPayload.equals(PNG_BUFFER)).toBe(true);

    // 匿名 / 错误 token 都不放行
    const anonymous = await app.inject({ method: "GET", url: `/api/v1/agent/media/${encodeURIComponent("联测电子厂_门头.png")}` });
    expect(anonymous.statusCode).toBe(403);
    const wrong = await app.inject({
      method: "GET", url: `/api/v1/agent/media/${encodeURIComponent("联测电子厂_门头.png")}`,
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.statusCode).toBe(403);
    // 不存在的资源 404（鉴权通过后）
    expect((await app.inject({ method: "GET", url: "/api/v1/agent/media/%E6%B2%A1%E6%9C%89.png", headers: svc })).statusCode).toBe(404);
  });

  it("rejects bad uploads and supports delete", async () => {
    expect((await upload("")).statusCode).toBe(422);
    expect((await upload("a.png", "audio")).statusCode).toBe(422);
    expect((await upload("a.png", "image", "not base64 !!")).statusCode).toBe(422);
    expect((await app.inject({
      method: "POST", url: "/api/v1/media",
      payload: { name: "x.png", kind: "image", data_base64: PNG_BASE64 },
    })).statusCode).toBe(403);

    const created = await upload("待删.png");
    const id = created.json().id as number;
    expect((await app.inject({ method: "DELETE", url: `/api/v1/media/${id}`, headers: admin })).json()).toMatchObject({ ok: true });
    expect((await app.inject({ method: "DELETE", url: `/api/v1/media/${id}`, headers: admin })).statusCode).toBe(404);
    expect(app.db.prepare("SELECT COUNT(*) n FROM media_assets WHERE id=?").get(id)).toMatchObject({ n: 0 });
  });

  it("serves video mime types by extension", async () => {
    const created = await upload("宿舍.mp4", "video");
    expect(created.statusCode).toBe(200);
    const res = await app.inject({
      method: "GET", url: `/api/v1/agent/media/${encodeURIComponent("宿舍.mp4")}`, headers: svc,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("video/mp4");
  });
});
