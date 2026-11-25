import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isProfileTokenValid } from "./profile.routes.js";
import { compatibleVideoPreview, imageThumbnail, videoThumbnail } from "../../shared/video-preview.js";
import {
  DIFY_MEDIA_NAME,
  difyMediaName,
  MEDIA_MAX_BYTES,
  mediaAbsolutePath,
  mediaDir,
  mimeOfName,
  safeExtension,
  type MediaKind,
} from "../../shared/media-assets.js";

/**
 * 媒体资源库（迁移 031）。
 *
 * 旧的「岗位话术 5 时点」接口已随 2026-11-17 的 Agent 重构废弃删除
 * （人设与开场改用 agent-persona.routes.ts 的 agent-persona / agent-opening）。
 * 本文件只保留媒体：上传 / 列表 / 删除 / 管理员预览与设备下载。
 *
 * 接口分两类鉴权：
 * - 后台配置类（/api/v1/media）→ 仅管理员，风格同 kb-v3；
 * - 媒体下载（GET /api/v1/agent/media/:name）→ 管理员 JWT、设备 token 或
 *   X-Profile-Token，供后台预览、Windows 客户端与 8090 服务读取。
 *
 * 大文件：base64 解码后超过 20MB 直接 413。视频真实体积常到几十 MB，
 * 这里先给一个能覆盖「门头照 + 30 秒短视频」的上限，超了请运营先压缩。
 */

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;
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

/** 设备 token：库里存 sha256(token)，反查设备编码后还要确认设备没被停用。 */
export function isValidDeviceToken(db: DatabaseSync, request: FastifyRequest): boolean {
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
    // 岗位绑定（2026-11-17 媒体分层）：0=通用池（全岗位可发），>0=岗位专属
    // （如面试地点图——各城市地址不同，图跟岗位走）。缺省 0 兼容旧调用。
    const positionId = Math.max(0, int(body.position_id) || 0);
    if (positionId > 0 && !db.prepare('SELECT id FROM service_positions WHERE id=?').get(positionId)) {
      return reply.code(422).send({ detail: '岗位不存在' });
    }
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
      `INSERT INTO media_assets(name,kind,storage_path,sha256,bytes,status,position_id)
       VALUES (?,?,?,?,?,'enabled',?)
       ON CONFLICT(name) DO UPDATE SET
         kind=excluded.kind, storage_path=excluded.storage_path,
         sha256=excluded.sha256, bytes=excluded.bytes, status='enabled'
       RETURNING id,name,kind,sha256,bytes,position_id`,
    ).get(name, kind, storagePath, sha256, buffer.length, positionId) as
      | { id: number; name: string; kind: string; sha256: string; bytes: number; position_id: number }
      | undefined;
    if (!row) return reply.code(500).send({ detail: "failed to store media" });
    return { id: Number(row.id), name: String(row.name), kind: String(row.kind), sha256: String(row.sha256), bytes: Number(row.bytes), position_id: Number(row.position_id ?? 0) };
  });

  app.get("/api/v1/media", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    // 素材库面板：带岗位绑定回显（0=通用池），岗位名 join 供下拉展示
    const rows = db.prepare(
      `SELECT m.id, m.name, m.kind, m.sha256, m.bytes, m.position_id, m.storage_path,
              p.position_name AS position_name
         FROM media_assets m
         LEFT JOIN service_positions p ON p.id = m.position_id
        WHERE m.status='enabled' ORDER BY m.id`,
    ).all() as Array<{ id: number; name: string; kind: MediaKind; sha256: string; bytes: number; position_id: number; position_name: string | null; storage_path: string }>;
    return {
      items: rows.map((row) => ({
        id: Number(row.id), name: String(row.name), kind: String(row.kind),
        sha256: String(row.sha256), bytes: Number(row.bytes ?? 0),
        position_id: Number(row.position_id ?? 0),
        position_name: row.position_name ?? null,
        supports_faq: Boolean(difyMediaName(row)),
      })),
      total: rows.length,
    };
  });

  // 绑定修改：素材库面板下拉即时保存（0=通用池，>0=岗位专属）。
  // position_id 校验存在性，防手滑绑到不存在的岗位导致事实卡注入空转。
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/v1/media/:id/binding",
    async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const id = int(request.params.id);
      if (id <= 0) return reply.code(404).send({ detail: "Not Found" });
      const positionId = Math.max(0, int((request.body ?? {}).position_id) || 0);
      if (positionId > 0) {
        const exists = db.prepare("SELECT id FROM service_positions WHERE id=?").get(positionId);
        if (!exists) return reply.code(422).send({ detail: "岗位不存在" });
      }
      const result = db.prepare("UPDATE media_assets SET position_id=? WHERE id=?").run(positionId, id);
      return result.changes ? { ok: true, position_id: positionId } : reply.code(404).send({ detail: "Not found" });
    },
  );

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
   * 媒体下载：管理员 JWT、设备 token 或 X-Profile-Token。
   * 响应头带 X-Content-SHA256 让客户端校验；Content-Type 按扩展名给，
   * 客户端保存到本地时不必再猜类型。
   */
  app.get<{ Params: { name: string }; Querystring: { preview?: string; version?: string } }>("/api/v1/agent/media/:name", async (request, reply) => {
    const compatibilityPreview = request.query.preview === "compatible";
    const thumbnail = request.query.preview === "thumbnail";
    if ((compatibilityPreview || thumbnail) && !isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    if (!isAdmin(request) && !isProfileTokenValid(request.headers["x-profile-token"]) && !isValidDeviceToken(db, request)) {
      return reply.code(403).send({ detail: "Not authenticated" });
    }
    const name = request.params.name;
    const alias = DIFY_MEDIA_NAME.exec(name);
    const row = (alias
      ? db.prepare("SELECT id,name,storage_path,sha256,kind FROM media_assets WHERE id=? AND sha256=? AND status='enabled'").get(Number(alias[1]),alias[2])
      : db.prepare("SELECT id,name,storage_path,sha256,kind FROM media_assets WHERE name=? AND status='enabled'").get(name));
    const asset = row as { id:number; name:string; storage_path:string; sha256:string; kind:MediaKind } | undefined;
    if (!asset || (alias && difyMediaName(asset)!==name)) return reply.code(404).send({ detail: "Media not found" });
    if (request.query.version !== undefined && request.query.version !== asset.sha256) {
      return reply.code(404).send({ detail: "Media not found" });
    }
    const absolute = mediaAbsolutePath(asset.storage_path);
    // storage_path 来自库内，但仍做一次越界检查：迁移写错也不能读到 data 之外。
    if (!absolute) return reply.code(404).send({ detail: "Media not found" });
    if (thumbnail) {
      // 列表预览专用：图片和视频都只回缩略图，**发送永远走不带 preview 的地址拿原图**。
      // 之前图片不支持 preview=thumbnail，前端列表只能整张原图拉进浏览器
      // （实测有 1080×22415、5.4MB 的面试点图）。
      if (asset.kind !== "video" && asset.kind !== "image") return reply.code(422).send({ detail: "仅支持图片和视频生成缩略图。" });
      if (!fs.existsSync(absolute)) return reply.code(404).send({ detail: "Media file missing" });
      const cover = asset.kind === "video"
        ? await videoThumbnail(absolute, asset.sha256)
        : await imageThumbnail(absolute, asset.sha256);
      if ("status" in cover) {
        if (cover.retryAfter) reply.header("Retry-After", cover.retryAfter);
        return reply.code(cover.status).send({ detail: cover.detail });
      }
      return reply.header("Cache-Control", "private, no-store").type("image/jpeg").send(cover.data);
    }
    if (compatibilityPreview) {
      if (asset.kind !== "video") return reply.code(422).send({ detail: "仅支持生成视频预览。" });
      if (!fs.existsSync(absolute)) return reply.code(404).send({ detail: "Media file missing" });
      const controller = new AbortController();
      const abort = () => controller.abort();
      reply.raw.once("close", abort);
      try {
        const preview = await compatibleVideoPreview(absolute, controller.signal);
        if (controller.signal.aborted) return reply;
        if ("status" in preview) return reply.code(preview.status).send({ detail: preview.detail });
        return reply.header("Cache-Control", "private, no-store").type("video/mp4").send(preview.data);
      } finally {
        reply.raw.removeListener("close", abort);
      }
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      return reply.code(404).send({ detail: "Media file missing" });
    }
    const storageMime = mimeOfName(asset.storage_path);
    return reply
      .code(200)
      .header("X-Content-SHA256", String(asset.sha256))
      .header("Content-Length", String(buffer.length))
      .header("Cache-Control", "private, max-age=3600")
      .type(storageMime === "application/octet-stream" ? mimeOfName(asset.name) : storageMime)
      .send(buffer);
  });
}
