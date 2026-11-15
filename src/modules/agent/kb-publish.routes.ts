import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { faqIssues, listOf } from "./kb-governance.js";

type Json = Record<string, any>;
class PublishError extends Error {
  constructor(public status: number, message: string, public issues?: unknown) { super(message); }
}

export function publicationSource(db: DatabaseSync) {
  const rows = db.prepare("SELECT * FROM kb_faq WHERE tenant_id=1 ORDER BY id").all() as Json[];
  if (rows.length > 2000) throw new PublishError(422, "一次最多发布2000条问答");
  const issues: Json[] = [];
  const items = rows.map(row => {
    if (!["global", "vertical"].includes(row.scope_level)) {
      issues.push({ id: row.id, detail: "当前发布只支持共享问答；城市、招工方和岗位需先建立跨库身份映射。" });
    }
    if (row.status === "enabled") {
      issues.push(...faqIssues(db, row).map(issue => ({ id: row.id, ...issue })));
    }
    const vertical = row.vertical_id ? db.prepare("SELECT code,status FROM vertical WHERE id=? AND tenant_id=1").get(row.vertical_id) : null;
    if (row.vertical_id && !vertical) issues.push({ id: row.id, detail: "品类归属缺失" });
    return {
      source_id: Number(row.id), vertical_code: vertical ? String(vertical.code) : null,
      scope_level: row.scope_level, question: row.question, answer: row.answer,
      keywords: listOf(row.keywords), media: listOf(row.media), priority: Number(row.priority), status: row.status,
    };
  });
  const revision = createHash("sha256").update(JSON.stringify({ items, verticals: db.prepare("SELECT id,code,status FROM vertical WHERE tenant_id=1 ORDER BY id").all() })).digest("hex");
  return { items, revision, issues };
}

function targetUrl() {
  const raw = process.env.REA_BRAIN_URL?.trim();
  if (!raw) throw new PublishError(503, "未配置实际回复服务 REA_BRAIN_URL，不能发布");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new PublishError(503, "实际回复服务地址配置无效");
  }
  return url.origin;
}

async function remote(base: string, path: string, body?: Json): Promise<Json> {
  const token = process.env.REA_PROFILE_TOKEN?.trim();
  if (!token) throw new PublishError(503, "未配置回复服务发布凭据");
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", "X-Profile-Token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new PublishError(502, "回复服务未返回确认；如已提交，可用同一预览重试核对，勿重复新建发布。");
  }
  const data = await response.json().catch(() => ({})) as Json;
  if (!response.ok) throw new PublishError(response.status === 409 ? 409 : response.status === 422 ? 422 : 502,
    typeof data.detail === "string" ? data.detail : `回复服务拒绝请求（${response.status}）`);
  return data;
}

export async function registerKbPublishRoutes(app: FastifyInstance, db: DatabaseSync) {
  const guarded = (handler: (request: any) => Promise<unknown>) => async (request: any, reply: any) => {
    if (request.auth?.role !== "admin") return reply.code(403).send({ detail: "Admin access required" });
    try { return await handler(request); }
    catch (error) {
      if (error instanceof PublishError) return reply.code(error.status).send({ detail: error.message, issues: error.issues });
      // No outbound headers, credentials, URLs with secrets, or raw fetch errors in responses.
      return reply.code(502).send({ detail: "发布检查失败，请检查回复服务配置后重试。" });
    }
  };

  app.post("/api/v1/kb-publish/preview", guarded(async request => {
    const source = publicationSource(db);
    const rollback = request.body?.rollback_of;
    if (rollback !== undefined && (typeof rollback !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(rollback))) throw new PublishError(422, "回滚编号无效");
    if (!rollback && source.issues.length) throw new PublishError(422, "请先整理待发布问答", source.issues);
    const base = targetUrl();
    const payload = rollback ? { rollback_of: rollback } : { items: source.items };
    const preview = await remote(base, "/api/v1/kb/publish/preview", payload);
    if (typeof preview.target_id !== "string" || typeof preview.target_revision !== "string" || !Array.isArray(preview.changes)) throw new PublishError(502, "回复服务返回的预览无效");
    const id = randomUUID();
    db.prepare("INSERT INTO kb_publication_preview(id,source_revision,target_url,target_id,request_json,preview_json,created_at,actor) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, source.revision, base, preview.target_id, JSON.stringify(payload), JSON.stringify(preview), Date.now(), request.auth.username);
    return { ...preview, preview_id: id, target_url: base, rollback_of: rollback ?? null,
      note: "仅发布共享场景问答；旧话术、岗位数据和流程图保持原样。删除的已发布问答会停用。" };
  }));

  app.post("/api/v1/kb-publish/apply", guarded(async request => {
    const id = request.body?.preview_id;
    if (typeof id !== "string") throw new PublishError(422, "请先预览再发布");
    const row = db.prepare("SELECT * FROM kb_publication_preview WHERE id=?").get(id) as Json | undefined;
    if (!row) throw new PublishError(404, "预览不存在");
    if (row.result_json) return { ...JSON.parse(row.result_json), replayed: true };
    if (targetUrl() !== row.target_url) throw new PublishError(409, "回复服务地址已变化，请重新预览");
    const payload = JSON.parse(row.request_json);
    if (!payload.rollback_of && publicationSource(db).revision !== row.source_revision) throw new PublishError(409, "后台问答或品类已变化，请重新预览");
    if (Date.now() - Number(row.created_at) > 15 * 60 * 1000) throw new PublishError(409, "预览已过期，请查看发布记录并重新预览");
    const preview = JSON.parse(row.preview_json);
    const result = await remote(row.target_url, "/api/v1/kb/publish/apply", {
      ...payload, publication_id: id, expected_target: row.target_id,
      expected_revision: preview.target_revision, expected_generation: preview.target_generation,
      payload_digest: preview.payload_digest,
    });
    if (result.publication_id !== id || result.target_id !== row.target_id || result.payload_digest !== preview.payload_digest) throw new PublishError(502, "回复服务确认与本次发布不一致，请查看发布记录");
    db.prepare("UPDATE kb_publication_preview SET result_json=? WHERE id=?").run(JSON.stringify(result), id);
    return result;
  }));

  app.get("/api/v1/kb-publish/history", guarded(async () => {
    const base = targetUrl();
    const [identity, history] = await Promise.all([
      remote(base, "/api/v1/instance"), remote(base, "/api/v1/kb/publish/history"),
    ]);
    return { ...history, target_url: base, target_id: identity.install_id };
  }));
}
