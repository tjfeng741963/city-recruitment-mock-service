import type { DatabaseSync } from "node:sqlite";
import path from "node:path";

/**
 * 岗位话术 + 媒体资源库的共享读取层（迁移 030 / 031）。
 *
 * 三处消费同一套解析规则，抽出来避免「后台存得进、下发看不见」：
 * - GET /api/v1/position-scripts（后台列表）
 * - GET /api/v1/agent/jobs（8090 岗位流，items[].media）
 * - GET /api/v1/bridge/devices/:code/config（客户端话术下发）
 *
 * 关键约定：
 * - 对外 media 永远是数组，不是 JSON 字符串；
 * - 引用名在 media_assets 里查不到 → 直接丢掉（不能让客户端拿到必然 404 的名字）；
 * - sha256 只在库里存在时返回，客户端据此校验下载内容。
 */

/** 单次上传上限：视频可能几十 MB，但 base64 走 JSON 会放大 1/3，先卡 20MB 可解码体积。 */
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export type MediaKind = "image" | "video";

/** service_positions.data_json.media 里的元素：只有名字与类型。 */
export type MediaRef = { name: string; kind: MediaKind };

/** media_assets 的一行（对外字段）。 */
export type MediaAsset = { id: number; name: string; kind: MediaKind; sha256: string; bytes: number };

/** 下发给客户端的媒体引用：名字 + 类型 + 校验和。 */
export type ResolvedMedia = { name: string; kind: MediaKind; sha256: string };

/** 话术下发/列表的对外形状。 */
export type PositionScriptPayload = {
  position_id: number;
  stage: string;
  title: string;
  content: string;
  media: ResolvedMedia[];
};

const MEDIA_NAME_MAX = 200;

/**
 * 文件落盘目录：契约要求落在 REA_DATABASE_PATH 所在目录下的 media/。
 * REA_MEDIA_DIR 是测试/容器的显式覆盖（测试用 :memory: 时必须换目录，
 * 否则会把夹具图片写进仓库的 data/）。
 */
export function mediaDir(): string {
  const explicit = (process.env.REA_MEDIA_DIR ?? "").trim();
  if (explicit) return path.resolve(explicit);
  const dbPath = (process.env.REA_DATABASE_PATH ?? "").trim();
  const root = dbPath && dbPath !== ":memory:" ? path.dirname(path.resolve(dbPath)) : path.resolve(process.cwd(), "data");
  return path.join(root, "media");
}

/**
 * storage_path（相对 data 目录，如 media/<sha>.jpg）→ 绝对路径。
 * 最终只允许落在 mediaDir() 内：库被写脏也不能读到 media 之外的文件。
 */
export function mediaAbsolutePath(storagePath: string): string | null {
  const root = path.resolve(mediaDir());
  const relative = storagePath.replace(/^media[\\/]/, "");
  const absolute = path.resolve(root, relative);
  return absolute.startsWith(root + path.sep) ? absolute : null;
}

function asKind(value: unknown): MediaKind {
  return value === "video" ? "video" : "image";
}

/** 单条媒体引用规范化：名字为空/非字符串/含路径分隔符一律丢弃。 */
function asMediaRef(value: unknown): MediaRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > MEDIA_NAME_MAX) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return { name, kind: asKind(raw.kind) };
}

/** media_json / data_json.media 的容错解析：坏 JSON 当空数组，绝不抛。 */
export function parseMediaRefs(raw: unknown): MediaRef[] {
  let value = raw;
  if (typeof value === "string") {
    if (!value) return [];
    try { value = JSON.parse(value) as unknown; } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: MediaRef[] = [];
  for (const item of value) {
    const ref = asMediaRef(item);
    if (ref && !out.some((existing) => existing.name === ref.name)) out.push(ref);
  }
  return out;
}

/**
 * 岗位 data_json 里的媒体清单。
 * POST /service-positions 会把整个请求体再嵌一层 data_json，所以两处都看。
 */
export function parsePositionMedia(raw: unknown): MediaRef[] {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    if (!parsed) return [];
    try { parsed = JSON.parse(parsed) as unknown; } catch { return []; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const top = parseMediaRefs(record.media);
  if (top.length) return top;
  const nested = record.data_json;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return parseMediaRefs((nested as Record<string, unknown>).media);
  }
  return [];
}

/** 按名字批量查媒体（只查启用的）。名字去重，查不到的直接不在 Map 里。 */
export function mediaAssetsByNames(db: DatabaseSync, names: string[]): Map<string, MediaAsset> {
  const unique = [...new Set(names.filter((name) => typeof name === "string" && name !== ""))];
  if (!unique.length) return new Map();
  // 只拼占位符，值全部走参数绑定。
  const placeholders = unique.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id,name,kind,sha256,bytes FROM media_assets
      WHERE status='enabled' AND name IN (${placeholders})`,
  ).all(...unique) as Array<{ id: number; name: string; kind: string; sha256: string; bytes: number }>;
  const map = new Map<string, MediaAsset>();
  for (const row of rows) {
    map.set(String(row.name), {
      id: Number(row.id),
      name: String(row.name),
      kind: asKind(row.kind),
      sha256: String(row.sha256),
      bytes: Number(row.bytes ?? 0),
    });
  }
  return map;
}

/** 引用 → 下发形状：丢掉库里不存在的资源（客户端拿不到文件的名字没有意义）。 */
export function resolveMediaRefs(refs: MediaRef[], assets: Map<string, MediaAsset>): ResolvedMedia[] {
  const out: ResolvedMedia[] = [];
  for (const ref of refs) {
    const asset = assets.get(ref.name);
    if (!asset) continue;
    out.push({ name: asset.name, kind: asset.kind, sha256: asset.sha256 });
  }
  return out;
}

type ScriptRow = { id: number; position_id: number; stage: string; title: string; content: string; media_json: string };

/** 批量把话术行的 media_json 解析成带 sha256 的数组。 */
export function hydrateScripts(db: DatabaseSync, rows: ScriptRow[]): PositionScriptPayload[] {
  const names = rows.flatMap((row) => parseMediaRefs(row.media_json).map((ref) => ref.name));
  const assets = mediaAssetsByNames(db, names);
  return rows.map((row) => ({
    position_id: Number(row.position_id),
    stage: String(row.stage),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    media: resolveMediaRefs(parseMediaRefs(row.media_json), assets),
  }));
}

/**
 * 配置下发用：只取 enabled 话术；绑了厂就只取这些厂岗位的话术。
 *
 * 用 JOIN 而不是 IN 子查询：话术指向已删除岗位时应该整条消失，
 * 否则客户端会拿到一个查不到岗位的话术。
 */
export function loadPositionScripts(db: DatabaseSync, factoryIds: number[]): PositionScriptPayload[] {
  const clause = factoryIds.length
    ? ` AND sp.factory_id IN (${factoryIds.map(() => "?").join(",")})`
    : "";
  const rows = db.prepare(
    `SELECT ps.id,ps.position_id,ps.stage,ps.title,ps.content,ps.media_json
       FROM position_scripts ps
       JOIN service_positions sp ON sp.id = ps.position_id
      WHERE ps.status='enabled'${clause}
      ORDER BY ps.position_id, ps.id`,
  ).all(...factoryIds) as ScriptRow[];
  return hydrateScripts(db, rows);
}

/** 话术表的最后一个更新时间，供 config 的 version 判定「有没有新配置」。 */
export function latestPositionScriptStamp(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT MAX(updated_at) AS at FROM position_scripts").get() as { at: string | null } | undefined;
  return row?.at ?? null;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  avi: "video/x-msvideo",
};

/** 扩展名 → Content-Type；未知一律 octet-stream（让客户端自己按 kind 处理）。 */
export function mimeOfName(name: string): string {
  const ext = path.extname(name).replace(".", "").toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** 文件名里的扩展名，只接受字母数字（防止 "a.jpg/../../x" 这类注入）。 */
export function safeExtension(name: string, kind: MediaKind): string {
  const ext = path.extname(name).replace(".", "").toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  return kind === "video" ? "mp4" : "jpg";
}
