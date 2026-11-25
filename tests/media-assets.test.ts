import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

/**
 * 媒体资源库（迁移 031）契约回归：
 * - POST /api/v1/media 落盘到 <data>/media/<sha256>.<ext> 并入库；
 * - sha256 与文件字节一致；GET /api/v1/agent/media/:name 下载内容一致；
 * - 下载鉴权接受管理员 JWT、设备 token 或 X-Profile-Token；
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
      { id: body.id, name: "联测电子厂_门头.png", kind: "image", sha256: PNG_SHA, bytes: PNG_BUFFER.length, position_id: 0, position_name: null, supports_faq: true },
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

  it("limits compatible previews to administrators and leaves the original download intact", async () => {
    const name = "image-preview-fixture.png";
    const created = await upload(name);
    expect(created.statusCode).toBe(200);
    const url = `/api/v1/agent/media/${name}`;
    const preview = `${url}?preview=compatible`;
    for (const headers of [device, svc, {}]) {
      expect((await app.inject({ method: "GET", url: preview, headers })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: preview, headers: admin })).statusCode).toBe(422);
    const original = await app.inject({ method: "GET", url, headers: device });
    expect(original.headers["x-content-sha256"]).toBe(PNG_SHA);
    expect(original.rawPayload.equals(PNG_BUFFER)).toBe(true);
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

  it("protects thumbnail requests and keeps a missing source distinct from a failed preview", async () => {
    const name = "封面-test.mp4";
    const created = await upload(name, "video");
    expect(created.statusCode).toBe(200);
    const url = `/api/v1/agent/media/${encodeURIComponent(name)}?preview=thumbnail`;
    for (const headers of [device, svc, {}]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(403);
    }
    // 图片也支持缩略图（列表预览用）：有 ffmpeg 回 JPEG，没有则明确 503，
    // 两种情况都不能影响不带 preview 的原图下载。
    const image = await upload("非封面.png");
    expect(image.statusCode).toBe(200);
    const imageThumb = await app.inject({
      url: `/api/v1/agent/media/${encodeURIComponent("非封面.png")}?preview=thumbnail`, headers: admin,
    });
    if (spawnSync("ffmpeg", ["-version"]).status === 0) {
      expect(imageThumb.statusCode).toBe(200);
      expect(imageThumb.headers["content-type"]).toBe("image/jpeg");
      expect(imageThumb.rawPayload.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    } else {
      expect(imageThumb.statusCode).toBe(503);
    }
    const original = await app.inject({
      url: `/api/v1/agent/media/${encodeURIComponent("非封面.png")}`, headers: admin,
    });
    expect(original.rawPayload.equals(PNG_BUFFER)).toBe(true);
    app.db.prepare("UPDATE media_assets SET storage_path=? WHERE name=?").run("media/missing-preview.mp4", name);
    expect((await app.inject({ url, headers: admin })).statusCode).toBe(404);
  });

  it("rejects stale content versions for both image and video thumbnail requests", async () => {
    const image = await upload("versioned.png");
    const video = await upload("versioned.mp4", "video");
    expect(image.statusCode).toBe(200);
    expect(video.statusCode).toBe(200);
    const wrongVersion = "0".repeat(64);
    expect((await app.inject({ url: `/api/v1/agent/media/versioned.png?version=${wrongVersion}`, headers: admin })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/agent/media/versioned.mp4?preview=thumbnail&version=${wrongVersion}`, headers: admin })).statusCode).toBe(404);
  });

  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)("serves the same valid JPEG cover through two names and preserves original video bytes", async () => {
    const fixture = path.join(mediaRoot, "thumbnail-fixture.mp4");
    const generated = spawnSync("ffmpeg", [
      "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:d=0.1",
      "-c:v", "libx264", "-threads", "1", fixture,
    ]);
    expect(generated.stderr.toString()).toBe("");
    expect(generated.status).toBe(0);
    const original = fs.readFileSync(fixture);
    const sha256 = createHash("sha256").update(original).digest("hex");
    const names = ["封面联测", "封面联测.mp4"];
    for (const name of names) {
      expect((await upload(name, "video", original.toString("base64"))).statusCode).toBe(200);
    }
    const [first, alias] = await Promise.all(names.map(name => app.inject({
      url: `/api/v1/agent/media/${encodeURIComponent(name)}?preview=thumbnail&version=${sha256}`,
      headers: admin,
    })));
    for (const cover of [first, alias]) {
      expect(cover.statusCode).toBe(200);
      expect(cover.headers["content-type"]).toBe("image/jpeg");
      expect(cover.rawPayload.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    }
    expect(first.rawPayload.equals(alias.rawPayload)).toBe(true);
    const download = await app.inject({ url: `/api/v1/agent/media/${encodeURIComponent(names[0])}`, headers: device });
    expect(download.rawPayload.equals(original)).toBe(true);
  });

  it.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0)(
    "gives the list a no-upscale thumbnail while sending still gets the original image",
    async () => {
      // 现场问题：面试地点.png 只有 78×132，列表里被 cover 裁成色块看不出来，
      // 而原图下载必须一字节不变——发送链路只认不带 preview 的地址。
      const fixture = path.join(mediaRoot, "tiny-source.png");
      const generated = spawnSync("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=78x132:d=0.1",
        "-frames:v", "1", fixture,
      ]);
      expect(generated.status).toBe(0);
      const original = fs.readFileSync(fixture);
      const sha256 = createHash("sha256").update(original).digest("hex");
      expect((await upload("面试地点-小图.png", "image", original.toString("base64"))).statusCode).toBe(200);

      const thumb = await app.inject({
        url: `/api/v1/agent/media/${encodeURIComponent("面试地点-小图.png")}?preview=thumbnail&version=${sha256}`,
        headers: admin,
      });
      expect(thumb.statusCode).toBe(200);
      expect(thumb.headers["content-type"]).toBe("image/jpeg");
      const thumbPath = path.join(mediaRoot, "thumb-check.jpg");
      fs.writeFileSync(thumbPath, thumb.rawPayload);
      const probe = spawnSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", thumbPath,
      ]);
      expect(probe.stdout.toString().trim()).toBe("78,132");

      const download = await app.inject({
        url: `/api/v1/agent/media/${encodeURIComponent("面试地点-小图.png")}`, headers: device,
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-type"]).toBe("image/png");
      expect(download.rawPayload.equals(original)).toBe(true);
    },
  );

  it("allows an authenticated administrator to preview media but rejects other user JWTs", async () => {
    await upload("管理员预览.png");
    const url = `/api/v1/agent/media/${encodeURIComponent("管理员预览.png")}`;
    const preview = await app.inject({ method: "GET", url, headers: admin });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload.equals(PNG_BUFFER)).toBe(true);
    expect(preview.headers["x-content-sha256"]).toBe(PNG_SHA);

    for (const username of ["local-recruiter", "local-customer"]) {
      const login = await app.inject({
        method: "POST", url: "/api/v1/auth/login",
        payload: { username, password: "local-demo-only" },
      });
      expect(login.statusCode).toBe(200);
      const result = await app.inject({
        method: "GET", url, headers: { authorization: `Bearer ${login.json().access_token}` },
      });
      expect(result.statusCode).toBe(403);
    }
  });

  it("serves an extensionless video using the storage file MIME type", async () => {
    expect((await upload("安检工作", "video")).statusCode).toBe(200);
    expect(app.db.prepare("SELECT storage_path FROM media_assets WHERE name=?").get("安检工作"))
      .toMatchObject({ storage_path: `media/${PNG_SHA}.mp4` });
    const res = await app.inject({
      method: "GET", url: `/api/v1/agent/media/${encodeURIComponent("安检工作")}`, headers: svc,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("video/mp4");
    expect(res.rawPayload.equals(PNG_BUFFER)).toBe(true);
  });
});
