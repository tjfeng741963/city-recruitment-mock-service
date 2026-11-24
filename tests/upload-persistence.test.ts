import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

// 上传接口必须真的落盘：之前只返回 {url} 从不写文件，前端显示「上传成功」
// 但打开是 404，而客户端的图片/视频发送依赖这些文件存在。
describe("upload endpoints persist files", () => {
  let app: FastifyInstance;
  let uploads: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    uploads = mkdtempSync(path.join(tmpdir(), "rea-uploads-"));
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_UPLOADS_DIR = uploads;
    process.env.REA_MESSAGE_CHANNEL_PROVIDER = "bridge";
    process.env.REA_DIFY_PROVIDER = "mock";
    app = buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    rmSync(uploads, { recursive: true, force: true });
    for (const key of ["REA_DATABASE_PATH", "REA_UPLOADS_DIR", "REA_MESSAGE_CHANNEL_PROVIDER", "REA_DIFY_PROVIDER"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const login = async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "local-admin", password: "local-demo-only" },
    });
    return { authorization: `Bearer ${res.json().access_token}` };
  };

  function multipart(filename: string, content: Buffer) {
    const boundary = "----rea-test-boundary";
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    return {
      body: Buffer.concat([head, content, tail]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  it("writes the uploaded image to disk and serves it back at the returned url", async () => {
    const headers = await login();
    const payload = Buffer.from("fake-png-bytes");
    const form = multipart("面试点图.png", payload);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/upload/image",
      headers: { ...headers, "content-type": form.contentType },
      payload: form.body,
    });
    expect(res.statusCode).toBe(200);
    const { url, filename } = res.json();
    expect(filename).toBe("面试点图.png");
    // URL 里的中文是 percent-encoded 的，先解码再断言
    expect(decodeURIComponent(String(url))).toMatch(/^\/uploads\/\d+-[a-z0-9]+-面试点图\.png$/);

    // 文件真的在磁盘上，内容一致
    const stored = path.join(uploads, decodeURIComponent(String(url).replace("/uploads/", "")));
    expect(readFileSync(stored)).toEqual(payload);

    // 并且能通过静态路由取回
    const served = await app.inject({ method: "GET", url: String(url) });
    expect(served.statusCode).toBe(200);
    expect(Buffer.from(served.rawPayload)).toEqual(payload);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["content-security-policy"]).toBe("sandbox");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sanitizes path separators in the original filename", async () => {
    const headers = await login();
    const form = multipart("..\\..\\evil.png", Buffer.from("x"));
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/upload/video",
      headers: { ...headers, "content-type": form.contentType },
      payload: form.body,
    });
    expect(res.statusCode).toBe(200);
    const url = String(res.json().url);
    expect(url).not.toContain("..");
    expect(url).not.toContain("%5C");
    // 落在 uploads 目录内，且只多一层（没有逃逸到上级）
    const name = decodeURIComponent(url.replace("/uploads/", ""));
    expect(name.includes("/")).toBe(false);
  });

  it("rejects a request without a file part", async () => {
    const headers = await login();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/upload/image",
      headers: { ...headers, "content-type": "multipart/form-data; boundary=----empty" },
      payload: Buffer.from("------empty--\r\n"),
    });
    expect(res.statusCode).toBe(422);
  });
});
