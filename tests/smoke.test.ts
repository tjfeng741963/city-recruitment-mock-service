import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../src/server.js";

describe("local static shell (legacy bundle)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_FRONTEND_DIR = "public";
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => {
    delete process.env.REA_FRONTEND_DIR;
    await app.close();
  });

  it.each(["/login", "/cities", "/m", "/service-positions"]) ("serves SPA shell for %s", async (route) => {
    const response = await app.inject({ method: "GET", url: route });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("城市招聘配置管理");
  });

  it("serves the captured root JavaScript bundle", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/index-BGyFQL9Q.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.body).toContain("LoginView-C_4Zg0lI.js");
  });
});

describe("local static shell (new frontend)", () => {
  let app: FastifyInstance;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "rea-frontend-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>新前端</title>");
    process.env.REA_DATABASE_PATH = ":memory:";
    process.env.REA_FRONTEND_DIR = dir;
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => {
    delete process.env.REA_FRONTEND_DIR;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["/", "/conversations", "/activation/customer/12"])("serves the configured frontend for %s", async (route) => {
    const response = await app.inject({ method: "GET", url: route });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("新前端");
  });
});
