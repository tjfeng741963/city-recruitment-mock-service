import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
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
    const response = await app.inject({ method: "GET", url: "/assets/index-C6QTH-aK.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.body).toMatch(/LoginView-[A-Za-z0-9_-]+\.js/);
  });
});

describe("local static shell (default)", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    process.env.REA_DATABASE_PATH = ":memory:";
    delete process.env.REA_FRONTEND_DIR;
    app = buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it("serves the re-themed legacy bundle without configuration", async () => {
    const response = await app.inject({ method: "GET", url: "/login" });
    expect(response.body).toContain("/assets/index-C6QTH-aK.js");
    expect(response.body).toContain('src="/theme/candidate-registration.js"');
    expect(response.body).toContain("/theme/theme.css");
    expect(response.body).toContain("/theme/motion.css");
    expect(response.body).toContain("/theme/glass.css");
    expect(response.body).toContain("/theme/sidebar.css");
    expect(response.body).toContain("/theme/sidebar.js");
    expect(response.body).toContain("/theme/device-code.js");
    expect(response.body).toContain("/theme/interaction.js");
  });

  it.each([
    ["/theme/theme.css", "text/css"],
    ["/theme/motion.css", "text/css"],
    ["/theme/glass.css", "text/css"],
    ["/theme/sidebar.css", "text/css"],
    ["/theme/sidebar.js", "javascript"],
    ["/theme/device-code.js", "javascript"],
    ["/theme/login-motion.js", "javascript"],
    ["/theme/interaction.js", "javascript"],
    ["/theme/candidate-registration.js", "javascript"],
    ["/theme/candidate-registration-table.js", "javascript"],
    ["/theme/candidate-registration.css", "text/css"],
    ["/theme/fonts/google-sans-flex-latin-wght-normal.woff2", "font/woff2"],
  ])("serves theme asset %s", async (url, type) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(type);
  });
});
