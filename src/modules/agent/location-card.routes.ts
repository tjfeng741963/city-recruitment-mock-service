import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { isProfileTokenValid } from "./profile.routes.js";
import { isValidDeviceToken } from "./position-scripts.routes.js";
import {
  decodeLocationCard,
  isLocationCardSha,
  locationCardSha,
  parseLocationCardLabels,
} from "../../shared/location-card.js";

/**
 * 企微原生位置卡（迁移 061）。
 *
 * 只有两件事：
 * - 采集：客户端把剪贴板里的 `WeWork Message` 字节上报上来（按 sha 去重）；
 * - 读取：后台列出已采集的卡，供面试点绑定。
 *
 * 发送不在这里——卡片字节随设备配置下发，客户端自己写剪贴板 + Ctrl+V，
 * 和媒体发送同一条路径（见 agent/location_card_send.py）。
 */

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;
const BODY_LIMIT = 64 * 1024;

type CardRow = { sha256: string; name: string; address: string; bytes: number; device_code: string; created_at: string };

function deviceCodeOf(db: DatabaseSync, request: FastifyRequest): string {
  const token = (request.headers.authorization ?? "").replace(/^Bearer /, "").trim();
  if (!token) return "";
  const hash = createHash("sha256").update(token).digest("hex");
  const row = db.prepare("SELECT device_code FROM bridge_devices WHERE token_hash=?").get(hash) as
    | { device_code: string }
    | undefined;
  return row ? String(row.device_code) : "";
}

export async function registerLocationCardRoutes(app: FastifyInstance, db: DatabaseSync) {
  const isAdmin = (request: FastifyRequest) => request.auth?.role === "admin";

  /**
   * 客户端上报剪贴板里采到的一张卡。
   * 幂等：同一张卡重复上报只更新 device_code，不会产生新行。
   */
  app.post<{ Body: Record<string, unknown> }>(
    "/api/v1/agent/location-card",
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const viaDevice = isValidDeviceToken(db, request);
      if (!viaDevice && !isProfileTokenValid(request.headers["x-profile-token"])) {
        return reply.code(403).send({ detail: "Not authenticated" });
      }
      const decoded = decodeLocationCard((request.body ?? {}).data_base64);
      if (!decoded.ok) return reply.code(422).send({ detail: decoded.detail });

      const sha = locationCardSha(decoded.bytes);
      const labels = parseLocationCardLabels(decoded.bytes);
      const deviceCode = deviceCodeOf(db, request);
      const existing = db.prepare("SELECT sha256 FROM location_cards WHERE sha256=?").get(sha);

      if (existing) {
        db.prepare("UPDATE location_cards SET device_code=? WHERE sha256=? AND device_code<>?").run(deviceCode, sha, deviceCode);
        return { sha256: sha, name: labels.name, address: labels.address, bytes: decoded.bytes.length, duplicate: true };
      }

      db.prepare(
        `INSERT INTO location_cards(sha256,blob_b64,bytes,name,address,device_code)
         VALUES (?,?,?,?,?,?)`,
      ).run(sha, decoded.bytes.toString("base64"), decoded.bytes.length, labels.name, labels.address, deviceCode);

      return { sha256: sha, name: labels.name, address: labels.address, bytes: decoded.bytes.length, duplicate: false };
    },
  );

  /** 后台列表：只回展示信息，不回 blob（blob 走设备配置下发，避免后台一次拉几十 KB）。 */
  app.get("/api/v1/location-cards", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const rows = db.prepare(
      `SELECT sha256,name,address,bytes,device_code,created_at
         FROM location_cards ORDER BY created_at DESC, sha256 LIMIT 200`,
    ).all() as CardRow[];
    return {
      items: rows.map((row) => ({
        sha256: String(row.sha256),
        name: String(row.name ?? ""),
        address: String(row.address ?? ""),
        bytes: Number(row.bytes ?? 0),
        device_code: String(row.device_code ?? ""),
        created_at: String(row.created_at ?? ""),
      })),
      total: rows.length,
    };
  });

  /** 删掉采错的卡。绑在面试点上的引用会变成「未采集」，不会崩。 */
  app.delete<{ Params: { sha: string } }>("/api/v1/location-cards/:sha", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const sha = request.params.sha;
    if (!isLocationCardSha(sha)) return reply.code(404).send({ detail: "Not found" });
    const result = db.prepare("DELETE FROM location_cards WHERE sha256=?").run(sha);
    return Number(result.changes ?? 0) ? { ok: true } : reply.code(404).send({ detail: "Not found" });
  });
}
