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

type CardRow = { sha256: string; name: string; address: string; bytes: number; device_code: string; account_id: string; created_at: string };

type DeviceIdentity = { device_code: string; account_id: string };

function deviceIdentityOf(db: DatabaseSync, request: FastifyRequest): DeviceIdentity {
  const token = (request.headers.authorization ?? "").replace(/^Bearer /, "").trim();
  if (!token) return { device_code: "", account_id: "" };
  const hash = createHash("sha256").update(token).digest("hex");
  const row = db.prepare("SELECT device_code,account_id FROM bridge_devices WHERE token_hash=?").get(hash) as DeviceIdentity | undefined;
  return row ? { device_code: String(row.device_code), account_id: String(row.account_id ?? "") } : { device_code: "", account_id: "" };
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
      const identity = deviceIdentityOf(db, request);
      const deviceCode = identity.device_code;
      const accountId = typeof (request.body ?? {}).account_id === "string" ? String((request.body ?? {}).account_id).trim() : identity.account_id;
      if (identity.account_id && accountId && accountId !== identity.account_id) return reply.code(409).send({ detail: "企微账号与设备当前账号不一致" });
      const sourceFavoriteId = typeof (request.body ?? {}).favorite_id === "string" ? String((request.body ?? {}).favorite_id).trim() : "";
      const existing = db.prepare("SELECT sha256 FROM location_cards WHERE sha256=?").get(sha);

      if (existing) {
        db.prepare("UPDATE location_cards SET device_code=?,account_id=?,source_favorite_id=? WHERE sha256=? AND (device_code<>? OR account_id<>? OR source_favorite_id<>?)")
          .run(deviceCode, accountId, sourceFavoriteId, sha, deviceCode, accountId, sourceFavoriteId);
        return { sha256: sha, name: labels.name, address: labels.address, bytes: decoded.bytes.length, duplicate: true };
      }

      db.prepare(
        `INSERT INTO location_cards(sha256,blob_b64,bytes,name,address,device_code,account_id,source_favorite_id)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(sha, decoded.bytes.toString("base64"), decoded.bytes.length, labels.name, labels.address, deviceCode, accountId, sourceFavoriteId);

      return { sha256: sha, name: labels.name, address: labels.address, bytes: decoded.bytes.length, duplicate: false };
    },
  );

  /**
   * 企微收藏快照。客户端必须在当前已登录账号下采集，完整快照才会删除本轮已消失的条目。
   * incomplete 快照只更新本轮出现的项，防止搜索分页或窗口被遮挡时误删收藏。
   */
  app.post<{ Body: Record<string, unknown> }>(
    "/api/v1/agent/location-favorites/sync",
    { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      if (!isValidDeviceToken(db, request)) return reply.code(403).send({ detail: "需要设备凭证" });
      const identity = deviceIdentityOf(db, request);
      const body = request.body ?? {};
      const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
      if (!accountId || (identity.account_id && accountId !== identity.account_id)) return reply.code(409).send({ detail: "企微账号与设备当前账号不一致" });
      const complete = body.complete === true;
      const snapshotId = typeof body.snapshot_id === "string" ? body.snapshot_id.trim().slice(0, 120) : "";
      const items = Array.isArray(body.items) ? body.items : [];
      const upsert = db.prepare(
        `INSERT INTO location_favorites(account_id,favorite_id,kind,title,address,location_card_sha,snapshot_id,observed_at)
         VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(account_id,favorite_id) DO UPDATE SET kind=excluded.kind,title=excluded.title,address=excluded.address,location_card_sha=excluded.location_card_sha,snapshot_id=excluded.snapshot_id,observed_at=excluded.observed_at`,
      );
      let accepted = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const raw of items) {
          if (!raw || typeof raw !== "object") continue;
          const item = raw as Record<string, unknown>;
          const favoriteId = typeof item.favorite_id === "string" ? item.favorite_id.trim().slice(0, 200) : "";
          const title = typeof item.title === "string" ? item.title.trim().slice(0, 200) : "";
          if (!favoriteId || !title) continue;
          const kind = item.kind === "other" ? "other" : "location";
          const address = typeof item.address === "string" ? item.address.trim().slice(0, 500) : "";
          const sha = typeof item.location_card_sha === "string" && isLocationCardSha(item.location_card_sha) ? item.location_card_sha : "";
          upsert.run(accountId, favoriteId, kind, title, address, sha, snapshotId);
          accepted += 1;
        }
        if (complete) db.prepare("DELETE FROM location_favorites WHERE account_id=? AND snapshot_id<>?").run(accountId, snapshotId);
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        throw error;
      }
      return { account_id: accountId, snapshot_id: snapshotId, complete, accepted, device_code: identity.device_code };
    },
  );

  /** 后台列表：只回展示信息，不回 blob（blob 走设备配置下发，避免后台一次拉几十 KB）。 */
  app.get("/api/v1/location-cards", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const accountId = typeof (request.query as Record<string, unknown> | undefined)?.account_id === "string"
      ? String((request.query as Record<string, unknown>).account_id).trim() : "";
    const rows = db.prepare(
      `SELECT sha256,name,address,bytes,device_code,account_id,created_at
         FROM location_cards ${accountId ? "WHERE account_id=?" : ""} ORDER BY created_at DESC, sha256 LIMIT 200`,
    ).all(...(accountId ? [accountId] : [])) as CardRow[];
    const favorites = db.prepare(
      `SELECT account_id,favorite_id,kind,title,address,location_card_sha,snapshot_id,observed_at
         FROM location_favorites ${accountId ? "WHERE account_id=?" : ""} ORDER BY observed_at DESC, title LIMIT 500`,
    ).all(...(accountId ? [accountId] : [])) as Array<Record<string, unknown>>;
    return {
      items: rows.map((row) => ({
        sha256: String(row.sha256),
        name: String(row.name ?? ""),
        address: String(row.address ?? ""),
        bytes: Number(row.bytes ?? 0),
        device_code: String(row.device_code ?? ""),
        account_id: String(row.account_id ?? ""),
        created_at: String(row.created_at ?? ""),
      })),
      total: rows.length,
      favorites: favorites.map((item) => ({
        account_id: String(item.account_id ?? ""), favorite_id: String(item.favorite_id ?? ""), kind: String(item.kind ?? "location"),
        title: String(item.title ?? ""), address: String(item.address ?? ""), location_card_sha: String(item.location_card_sha ?? ""),
        snapshot_id: String(item.snapshot_id ?? ""), observed_at: String(item.observed_at ?? ""),
      })),
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
