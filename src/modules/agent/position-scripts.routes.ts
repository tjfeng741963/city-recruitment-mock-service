import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { authorizeProfileRequest } from "./profile.routes.js";
import {
  MEDIA_MAX_BYTES,
  mediaAbsolutePath,
  mediaAssetsByNames,
  mediaDir,
  mimeOfName,
  parseMediaRefs,
  safeExtension,
  type MediaKind,
} from "../../shared/media-assets.js";

/**
 * 岗位话术 + 媒体资源库（迁移 030 / 031，四端冻结契约）。
 *
 * 接口分两类鉴权：
 * - 后台配置类（/api/v1/position-scripts、/api/v1/media）→ 仅管理员，风格同 kb-v3；
 * - 媒体下载（GET /api/v1/agent/media/:name）→ 设备 token 或 X-Profile-Token，
 *   因为下载方是客户端（设备）与 8090（服务间），它们都没有用户 JWT。
 *
 * 大文件：base64 解码后超过 20MB 直接 413。视频真实体积常到几十 MB，
 * 这里先给一个能覆盖「门头照 + 30 秒短视频」的上限，超了请运营先压缩。
 */

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;
/**
 * 话术时点白名单（2026-11-17 扩充）。
 *
 * 前五个是发卡流程里的固定节点；后五个是原来写死在 flow_engine 里的流程文字，
 * 运营提「流程要能看到、能改」，所以它们也进同一张表、同一个抽屉：
 *   ask_city   还没选定岗位时问城市（可用 {{cities}}）
 *   collect    要姓名/手机号（可用 {{missing}}）
 *   gave_up    客户说不去时的收尾语
 *   reopen     流失客户重新回来时的第一句
 *   closing    流失后再发消息时的收尾语
 * 这五个基本都发生在「还没钉岗位」的时候，所以 position_id 允许为 0（通用条目）。
 */
const SCRIPT_STAGES = new Set([
  "greet", "send_info", "ask_interview", "booked", "unanswered",
  "ask_city", "collect", "gave_up", "reopen", "closing",
]);
const MEDIA_KINDS = new Set<MediaKind>(["image", "video"]);
/** JSON 里的 base64 比原始字节大约 1/3，路由级 bodyLimit 必须比 20MB 宽。 */
const MEDIA_BODY_LIMIT = 32 * 1024 * 1024;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

type ScriptRow = {
  id: number; position_id: number; stage: string; title: string;
  content: string; media_json: string; status: string;
};

/** 后台返回形状：media 是解析后的数组，不是字符串。 */
function serializeScript(db: DatabaseSync, row: ScriptRow) {
  // 后台列表保留运营配置的全部名字（哪怕文件还没上传），能查到资源时补 sha256，
  // 这样「配了但没传文件」在页面上是可见的，不会静默消失。
  const refs = parseMediaRefs(row.media_json);
  const assets = mediaAssetsByNames(db, refs.map((ref) => ref.name));
  return {
    id: Number(row.id),
    position_id: Number(row.position_id),
    stage: String(row.stage),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    media: refs.map((ref) => {
      const asset = assets.get(ref.name);
      return asset
        ? { name: asset.name, kind: asset.kind, sha256: asset.sha256 }
        : { name: ref.name, kind: ref.kind };
    }),
    status: String(row.status),
  };
}

/** 设备 token：库里存 sha256(token)，反查设备编码后还要确认设备没被停用。 */
function isValidDeviceToken(db: DatabaseSync, request: FastifyRequest): boolean {
  const token = (request.headers.authorization ?? "").replace(/^Bearer /, "").trim();
  if (!token) return false;
  const hash = createHash("sha256").update(token).digest("hex");
  const row = db.prepare("SELECT device_code FROM bridge_devices WHERE token_hash=?").get(hash) as
    | { device_code: string }
    | undefined;
  if (!row) return false;
  return Boolean(
    db.prepare("SELECT id FROM agent_devices WHERE json_extract(data_json,'$.device_code')=? AND status='enabled'").get(row.device_code),
  );
}

type DecodeResult = { ok: true; buffer: Buffer } | { ok: false; reason: "invalid" | "too_large" };

/** base64 容错：允许 data URL 前缀，也允许换行。 */
function decodeBase64(raw: string): DecodeResult {
  const comma = raw.indexOf(",");
  const body = raw.startsWith("data:") && comma > 0 ? raw.slice(comma + 1) : raw;
  const cleaned = body.replace(/\s+/g, "");
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return { ok: false, reason: "invalid" };
  // 先按长度估算，避免为一个明显超限的串分配几十 MB 内存。
  const estimated = Math.floor((cleaned.length * 3) / 4) - (cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0);
  if (estimated > MEDIA_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, buffer: Buffer.from(cleaned, "base64") };
}

export async function registerPositionScriptRoutes(app: FastifyInstance, db: DatabaseSync) {
  const isAdmin = (request: FastifyRequest) => request.auth?.role === "admin";

  // ── 岗位话术 ──────────────────────────────────────────────────
  app.get<{ Querystring: { position_id?: string } }>("/api/v1/position-scripts", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const raw = String(request.query.position_id ?? "").trim();
    const positionId = raw ? int(raw) : 0;
    if (raw && (positionId < 0 || !Number.isSafeInteger(Number(raw)))) return reply.code(422).send({ detail: "position_id must be a nonnegative integer" });
    const rows = (raw
      ? db.prepare("SELECT * FROM position_scripts WHERE position_id=? ORDER BY id").all(positionId)
      : db.prepare("SELECT * FROM position_scripts ORDER BY position_id, id").all()) as ScriptRow[];
    return { items: rows.map((row) => serializeScript(db, row)), total: rows.length };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/v1/position-scripts", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const positionId = int(body.position_id);
    const general = body.position_id === 0 || body.position_id === "0";
    if (!general && positionId <= 0) return reply.code(422).send({ detail: "position_id is required" });
    const stage = text(body.stage).trim();
    if (!SCRIPT_STAGES.has(stage)) {
      return reply.code(422).send({ detail: "stage must be one of greet, ask_city, send_info, ask_interview, collect, booked, gave_up, reopen, closing, unanswered" });
    }
    // 通用条目（position_id=0）现在是「所有岗位共用的兜底文案」：问城市、要资料、
    // 收尾语这些时点本来就没有岗位可选，只能配通用条目。2026-11-17 起不再限制
    // 只允许 greet——否则运营在页面上根本填不了这几步。
    if (!general && !db.prepare("SELECT id FROM service_positions WHERE id=?").get(positionId)) {
      return reply.code(422).send({ detail: "position not found" });
    }
    const status = text(body.status).trim() || "enabled";
    if (!["enabled", "disabled"].includes(status)) {
      return reply.code(422).send({ detail: "status must be enabled or disabled" });
    }
    if (status === "enabled" && !text(body.content).split(/^[ \t]*---[ \t]*\r?$/m).some((part) => part.trim())) {
      return reply.code(422).send({
        detail: general && stage === "greet" ? "请填写至少一条欢迎语" : "请填写正文",
      });
    }
    // media 只保留 {name,kind}，sha256 由 media_assets 提供，不接受客户端自报。
    const media = parseMediaRefs(body.media).map((ref) => ({ name: ref.name, kind: ref.kind }));
    const row = db.prepare(
      `INSERT INTO position_scripts(position_id,stage,title,content,media_json,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
       ON CONFLICT(position_id,stage) DO UPDATE SET
         title=excluded.title, content=excluded.content, media_json=excluded.media_json,
         status=excluded.status, updated_at=CURRENT_TIMESTAMP
       RETURNING *`,
    ).get(positionId, stage, text(body.title), text(body.content), JSON.stringify(media), status) as ScriptRow;
    return serializeScript(db, row);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/position-scripts/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    if (id <= 0) return reply.code(404).send({ detail: "Not Found" });
    const result = db.prepare("DELETE FROM position_scripts WHERE id=?").run(id);
    if (Number(result.changes ?? 0) === 0) return reply.code(404).send({ detail: "Not found" });
    return { ok: true };
  });

  // ── 媒体资源库 ────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/v1/media", { bodyLimit: MEDIA_BODY_LIMIT }, async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const name = text(body.name).trim();
    if (!name) return reply.code(422).send({ detail: "name is required" });
    if (name.length > 200) return reply.code(422).send({ detail: "name is too long" });
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      return reply.code(422).send({ detail: "name must not contain path separators" });
    }
    const kind = text(body.kind).trim() as MediaKind;
    if (!MEDIA_KINDS.has(kind)) return reply.code(422).send({ detail: "kind must be image or video" });
    const base64 = text(body.data_base64);
    if (!base64) return reply.code(422).send({ detail: "data_base64 is required" });
    const decoded = decodeBase64(base64);
    if (!decoded.ok) {
      return decoded.reason === "too_large"
        ? reply.code(413).send({ detail: `decoded file exceeds ${MEDIA_MAX_BYTES} bytes` })
        : reply.code(422).send({ detail: "data_base64 is not valid base64" });
    }
    const buffer = decoded.buffer;
    if (!buffer.length) return reply.code(422).send({ detail: "data_base64 is empty" });

    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const extension = safeExtension(name, kind);
    const filename = `${sha256}.${extension}`;
    // storage_path 相对 data 根目录，契约里就是 media/<sha256>.<ext>。
    const storagePath = `media/${filename}`;
    const dir = mediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const absolute = path.join(dir, filename);
    // 内容寻址：同内容已存在就不重写（避免并发上传互相覆盖字节）。
    if (!fs.existsSync(absolute)) fs.writeFileSync(absolute, buffer);

    const row = db.prepare(
      `INSERT INTO media_assets(name,kind,storage_path,sha256,bytes,status)
       VALUES (?,?,?,?,?,'enabled')
       ON CONFLICT(name) DO UPDATE SET
         kind=excluded.kind, storage_path=excluded.storage_path,
         sha256=excluded.sha256, bytes=excluded.bytes, status='enabled'
       RETURNING id,name,kind,sha256,bytes`,
    ).get(name, kind, storagePath, sha256, buffer.length) as
      | { id: number; name: string; kind: string; sha256: string; bytes: number }
      | undefined;
    if (!row) return reply.code(500).send({ detail: "failed to store media" });
    return { id: Number(row.id), name: String(row.name), kind: String(row.kind), sha256: String(row.sha256), bytes: Number(row.bytes) };
  });

  app.get("/api/v1/media", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const rows = db.prepare("SELECT id,name,kind,sha256,bytes FROM media_assets WHERE status='enabled' ORDER BY id")
      .all() as Array<{ id: number; name: string; kind: string; sha256: string; bytes: number }>;
    return {
      items: rows.map((row) => ({
        id: Number(row.id), name: String(row.name), kind: String(row.kind),
        sha256: String(row.sha256), bytes: Number(row.bytes ?? 0),
      })),
      total: rows.length,
    };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/media/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    if (id <= 0) return reply.code(404).send({ detail: "Not Found" });
    const result = db.prepare("DELETE FROM media_assets WHERE id=?").run(id);
    if (Number(result.changes ?? 0) === 0) return reply.code(404).send({ detail: "Not found" });
    // 文件按 sha256 命名，可能被别的名字共用，所以只删记录不删文件；
    // 真正清理由运维按 sha 引用计数处理，避免误删还在用的话术配图。
    return { ok: true };
  });

  /**
   * 媒体下载：设备 token 或 X-Profile-Token。
   * 响应头带 X-Content-SHA256 让客户端校验；Content-Type 按扩展名给，
   * 客户端保存到本地时不必再猜类型。
   */
  app.get<{ Params: { name: string } }>("/api/v1/agent/media/:name", async (request, reply) => {
    if (!authorizeProfileRequest(request) && !isValidDeviceToken(db, request)) {
      return reply.code(403).send({ detail: "Not authenticated" });
    }
    const name = request.params.name;
    const row = db.prepare("SELECT name,storage_path,sha256,kind FROM media_assets WHERE name=? AND status='enabled'")
      .get(name) as { name: string; storage_path: string; sha256: string; kind: string } | undefined;
    if (!row) return reply.code(404).send({ detail: "Media not found" });
    const absolute = mediaAbsolutePath(row.storage_path);
    // storage_path 来自库内，但仍做一次越界检查：迁移写错也不能读到 data 之外。
    if (!absolute) return reply.code(404).send({ detail: "Media not found" });
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      return reply.code(404).send({ detail: "Media file missing" });
    }
    return reply
      .code(200)
      .header("X-Content-SHA256", String(row.sha256))
      .header("Content-Length", String(buffer.length))
      .header("Cache-Control", "private, max-age=3600")
      .type(mimeOfName(row.name))
      .send(buffer);
  });
}
