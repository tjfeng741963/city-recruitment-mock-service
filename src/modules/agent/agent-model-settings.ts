import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { rolePreHandler } from "../../auth/rbac.js";
import { complete, environmentModel, parseJsonObject, type ModelConfig } from "./agent-llm.js";
import { ModelProviderError, modelBaseUrl, providerRequest } from "./agent-model-transport.js";

type StoredModel = { base_url: string; encrypted_key: string; model: string; revision: number; updated_at: string };
const route = "/api/v1/settings/agent/model";
const proofLifetime = 5 * 60_000;

function row(db: DatabaseSync): StoredModel | undefined {
  return db.prepare("SELECT base_url,encrypted_key,model,revision,updated_at FROM agent_model_settings WHERE id=1")
    .get() as StoredModel | undefined;
}

function secret(purpose: string): Buffer {
  const value = process.env.AGENT_LLM_CONFIG_SECRET?.trim() || process.env.REA_LOCAL_JWT_SECRET?.trim();
  if (!value || value.length < 24) {
    throw new ModelProviderError("settings_secret", "服务端尚未配置模型密钥保护，请联系部署管理员");
  }
  return Buffer.from(hkdfSync("sha256", value, "city-recruitment-agent", purpose, 32));
}

function encryptKey(apiKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret("encryption"), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decryptKey(value: string): string {
  const key = secret("encryption");
  try {
    const data = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
  } catch {
    throw new ModelProviderError("settings_secret", "无法解密已保存的模型 Key，请联系部署管理员");
  }
}

export function activeAgentModel(db: DatabaseSync): ModelConfig {
  const current = row(db);
  const defaults = environmentModel();
  return current
    ? { baseUrl: current.base_url, apiKey: decryptKey(current.encrypted_key), model: current.model,
        timeoutMs: defaults.timeoutMs, managed: true }
    : defaults;
}

export function agentModelStatus(db: DatabaseSync) {
  const current = row(db);
  const defaults = environmentModel();
  return {
    base_url: current?.base_url ?? defaults.baseUrl,
    model: current?.model ?? defaults.model,
    source: current ? "settings" : "environment",
    key_configured: current ? true : Boolean(defaults.apiKey),
    revision: current?.revision ?? 0,
    updated_at: current?.updated_at ?? null,
  };
}

function field(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireProtectedOrigin(request: FastifyRequest) {
  // Loopback also supports the SSH tunnel used by operators of HTTP deployments.
  const isLoopback = (hostname: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  const origin = request.headers.origin;
  let originUrl: URL | undefined;
  try { originUrl = origin ? new URL(origin) : undefined; } catch { /* reject invalid origins below */ }
  const settingsPort = Number(process.env.REA_AGENT_SETTINGS_PORT ?? 0);
  const socket = request.raw.socket;
  const localConnection = settingsPort
    ? socket.localPort === settingsPort
    : isLoopback(socket.remoteAddress ?? "") && isLoopback(socket.localAddress ?? "127.0.0.1");
  if ((request.protocol === "https" && (!origin || originUrl?.protocol === "https:")) ||
      (localConnection && isLoopback(request.hostname) &&
        (!origin || (originUrl?.protocol === "http:" && originUrl.host === request.host)))) return;
  throw new ModelProviderError("insecure_origin", "请通过 HTTPS 或本机安全转发打开设置后再提交 Key");
}

function draftCredentials(db: DatabaseSync, body: Record<string, unknown>) {
  const suppliedUrl = field(body.base_url);
  if (!suppliedUrl || suppliedUrl.length > 512) throw new ModelProviderError("invalid_provider_url", "请填写有效的模型 API 地址");
  const baseUrl = modelBaseUrl(suppliedUrl);
  let apiKey = field(body.api_key);
  if (!apiKey) {
    const current = activeAgentModel(db);
    let activeUrl: string | undefined;
    try { activeUrl = modelBaseUrl(current.baseUrl); } catch { /* a legacy URL is not reusable */ }
    if (activeUrl === baseUrl) apiKey = current.apiKey;
  }
  if (!apiKey || apiKey.length > 2048 || /[^\x21-\x7e]/.test(apiKey)) {
    throw new ModelProviderError("invalid_provider_key", "请填写该供应商的有效 API Key");
  }
  return { baseUrl, apiKey };
}

function signedDraft(user: number, revision: unknown, draft: ModelConfig, expires: number): Buffer {
  return createHmac("sha256", secret("test-proof"))
    .update(JSON.stringify([user, revision, draft.baseUrl, draft.apiKey, draft.model, expires])).digest();
}

export function registerAgentModelSettings(app: FastifyInstance, db: DatabaseSync) {
  const admin = { preHandler: rolePreHandler("admin") };
  app.get(route, admin, (_request, reply) => reply.header("Cache-Control", "no-store").send(agentModelStatus(db)));

  for (const action of ["models", "test", "save"] as const) {
    app.route<{ Body: Record<string, unknown> }>({
      ...admin,
      method: action === "save" ? "PUT" : "POST",
      url: action === "save" ? route : route + "/" + action,
      bodyLimit: 8192,
      async handler(request, reply) {
        reply.header("Cache-Control", "no-store");
        const body = request.body ?? {};
        try {
          requireProtectedOrigin(request);
          const credentials = draftCredentials(db, body);
          if (action === "models") {
            const catalog = await providerRequest(credentials.baseUrl, credentials.apiKey, "models", 12_000) as { data?: unknown };
            if (!Array.isArray(catalog?.data)) {
              throw new ModelProviderError("provider_no_catalog", "供应商未提供可读的模型列表，可手动填写模型 ID 后测试");
            }
            const ids = catalog.data.map(item => field(item?.id))
              .filter(id => id && id.length <= 200 && !id.includes(credentials.apiKey));
            return { models: Array.from(new Set(ids)).sort().slice(0, 1000) };
          }
          const revision = row(db)?.revision ?? 0;
          if (body.revision !== revision) return reply.code(409).send({ detail: "生效配置已更新，请重新加载后测试" });
          const model = field(body.model);
          if (!model || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model) ||
              model.includes(credentials.apiKey) || /(?:reasoner|thinking|glm-z1|(?:^|[\W_])(?:r1|qwq)(?:$|[\W_]))/i.test(model)) {
            return reply.code(422).send({ detail: "请选择有效的非思考对话模型" });
          }
          const draft = { ...credentials, model, timeoutMs: 20_000, managed: true };
          const user = request.auth!.id;
          if (action === "test") {
            const expires = Date.now() + proofLifetime;
            const signature = signedDraft(user, revision, draft, expires);
            const result = await complete([
              { role: "system", content: "Connectivity check. Respond only with a JSON object with a messages array containing one item with type text and nonempty content." },
              { role: "user", content: "Reply briefly with the requested JSON." },
            ], { temperature: 0.1, maxTokens: 160 }, draft);
            let output: unknown;
            try { output = parseJsonObject(result.content).messages; } catch { /* give a fixed error below */ }
            if (!Array.isArray(output) || !output.length || !output.every(item => item?.type === "text" && field(item?.content))) {
              return reply.code(422).send({ detail: "模型可连接，但没有返回 Agent 所需的 JSON 格式" });
            }
            return { test_id: `${expires}.${signature.toString("hex")}`, latency_ms: result.latency_ms };
          }
          const proof = /^(\d{13})\.([a-f0-9]{64})$/.exec(field(body.test_id));
          const expires = Number(proof?.[1]);
          if (!proof || expires <= Date.now() ||
              !timingSafeEqual(Buffer.from(proof[2], "hex"), signedDraft(user, revision, draft, expires))) {
            return reply.code(409).send({ detail: "请先测试当前 URL、Key 和模型，再保存启用" });
          }
          const changed = db.prepare(`INSERT INTO agent_model_settings(id,base_url,encrypted_key,model,revision,updated_at)
            VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET base_url=excluded.base_url,encrypted_key=excluded.encrypted_key,
            model=excluded.model,revision=excluded.revision,updated_at=excluded.updated_at WHERE agent_model_settings.revision=?`)
            .run(draft.baseUrl, encryptKey(draft.apiKey), model, revision + 1, new Date().toISOString(), revision);
          if (!changed.changes) return reply.code(409).send({ detail: "生效配置已更新，请重新测试" });
          return agentModelStatus(db);
        } catch (error) {
          if (!(error instanceof ModelProviderError)) throw error;
          const status = error.code === "insecure_origin" ? 400 : error.code === "settings_secret" ? 503 :
            error.code.startsWith("invalid_") || error.code === "provider_reasoning" ? 422 : 502;
          return reply.code(status).send({ code: error.code, detail: error.message });
        }
      },
    });
  }
}
