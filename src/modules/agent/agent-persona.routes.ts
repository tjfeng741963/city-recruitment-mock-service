import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { openingVersion } from "../../shared/opening-version.js";

/**
 * 岗位人设 + 开场条目（迁移 038）。
 *
 * 契约：
 *   GET    /api/v1/agent-persona?position_id=  → { persona, openings, total }
 *   PUT    /api/v1/agent-persona               → 保存人设（按 position_id upsert）
 *   POST   /api/v1/agent-opening               → 追加一条开场（自动排到末尾）
 *   PUT    /api/v1/agent-opening/:id           → 改一条
 *   DELETE /api/v1/agent-opening/:id           → 删一条
 *   POST   /api/v1/agent-opening/reorder       → 按给定 id 顺序重排
 *
 * 三个约束写在这里，而不是交给前端：
 *   1. kind 只能是 text / image / video；
 *   2. text 必须有正文，image / video 必须有素材名；
 *   3. delay_ms 下限 2000——「每条至少隔 2 秒」是业务硬要求，前端传 0 也不认。
 *
 * 鉴权与 position-scripts 一致：后台配置接口只允许管理员。
 */

const ADMIN_REQUIRED = { detail: "Admin access required" } as const;
const KINDS = new Set(["text", "image", "video"]);
const MAX_OPENINGS = 30;
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 60_000;
const MAX_PERSONA_CHARS = 20_000;
const MAX_TEXT_CHARS = 2_000;

type PersonaRow = {
  id: number;
  position_id: number;
  content: string;
  status: string;
};

type OpeningRow = {
  id: number;
  position_id: number;
  seq: number;
  kind: string;
  content: string;
  media_name: string;
  delay_ms: number;
  status: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function int(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function serializePersona(row: PersonaRow | undefined) {
  if (!row) return null;
  return {
    id: Number(row.id),
    position_id: Number(row.position_id),
    content: String(row.content ?? ""),
    status: String(row.status ?? "enabled"),
  };
}

function serializeOpening(db: DatabaseSync, row: OpeningRow) {
  const mediaName = String(row.media_name ?? "");
  // 素材配了但还没上传时也要能看见：exists=false 让前端标红，而不是静默消失。
  const exists = mediaName
    ? Boolean(db.prepare("SELECT id FROM media_assets WHERE name=? AND status='enabled'").get(mediaName))
    : false;
  return {
    id: Number(row.id),
    position_id: Number(row.position_id),
    seq: Number(row.seq ?? 0),
    kind: String(row.kind ?? "text"),
    content: String(row.content ?? ""),
    media_name: mediaName,
    delay_ms: Number(row.delay_ms ?? MIN_DELAY_MS),
    status: String(row.status ?? "enabled"),
    media_exists: exists,
  };
}

/** 校验一条开场的内容与素材，返回错误文案（null 表示通过）。 */
function validateOpening(db: DatabaseSync, body: Record<string, unknown>, kind: string) {
  if (!KINDS.has(kind)) return "kind must be one of text, image, video";
  if (kind === "text") {
    const content = text(body.content).trim();
    if (!content) return "text 开场必须有正文";
    if (content.length > MAX_TEXT_CHARS) return `正文不能超过 ${MAX_TEXT_CHARS} 字`;
    return null;
  }
  const mediaName = text(body.media_name).trim();
  if (!mediaName) return `${kind} 开场必须选择素材`;
  if (mediaName.includes("/") || mediaName.includes("\\") || mediaName.includes("..")) {
    return "media_name 不能包含路径分隔符";
  }
  return null;
}

function clampDelay(value: unknown): number {
  const raw = int(value);
  if (!raw) return MIN_DELAY_MS;
  return Math.min(Math.max(raw, MIN_DELAY_MS), MAX_DELAY_MS);
}

function openingRevision(items: ReturnType<typeof serializeOpening>[]): string {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

export async function registerAgentPersonaRoutes(app: FastifyInstance, db: DatabaseSync) {
  const isAdmin = (request: FastifyRequest) => request.auth?.role === "admin";

  function positionExists(positionId: number): boolean {
    return Boolean(db.prepare("SELECT id FROM service_positions WHERE id=?").get(positionId));
  }

  function listOpenings(positionId: number) {
    const rows = db
      .prepare(
        `SELECT * FROM position_opening
          WHERE position_id=?
          ORDER BY status='disabled', seq, id`,
      )
      .all(positionId) as OpeningRow[];
    return rows.map((row) => serializeOpening(db, row));
  }

  // ── 读取：人设 + 开场一次给全 ──────────────────────────────────
  // 不带 position_id 时返回全量摘要，供列表页在按钮上显示「已配几条」——
  // 一页几十行，不能一行一个请求。
  app.get<{ Querystring: { position_id?: string } }>(
    "/api/v1/agent-persona",
    async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const raw = String(request.query.position_id ?? "").trim();
      if (!raw) {
        const personas = db
          .prepare("SELECT position_id, status FROM agent_persona")
          .all() as Array<{ position_id: number; status: string }>;
        const counts = db
          .prepare(
            `SELECT position_id, COUNT(*) AS n FROM position_opening
              WHERE status='enabled' GROUP BY position_id`,
          )
          .all() as Array<{ position_id: number; n: number }>;
        const byPosition = new Map<
          number,
          { position_id: number; has_persona: boolean; opening_count: number }
        >();
        for (const row of personas) {
          const id = Number(row.position_id);
          byPosition.set(id, {
            position_id: id,
            has_persona: String(row.status) === "enabled",
            opening_count: 0,
          });
        }
        for (const row of counts) {
          const id = Number(row.position_id);
          const current = byPosition.get(id) ?? {
            position_id: id,
            has_persona: false,
            opening_count: 0,
          };
          current.opening_count = Number(row.n ?? 0);
          byPosition.set(id, current);
        }
        const items = [...byPosition.values()].sort((a, b) => a.position_id - b.position_id);
        return { items, total: items.length };
      }

      const positionId = int(raw);
      if (positionId <= 0) {
        return reply.code(422).send({ detail: "position_id must be a positive integer" });
      }
      const persona = db
        .prepare("SELECT * FROM agent_persona WHERE position_id=?")
        .get(positionId) as PersonaRow | undefined;
      const openings = listOpenings(positionId);
      return {
        persona: serializePersona(persona),
        openings,
        total: openings.length,
        opening_version: openingVersion(positionId, openings),
        opening_revision: openingRevision(openings),
      };
    },
  );

  // ── 人设：按岗位 upsert ────────────────────────────────────────
  app.put<{ Body: Record<string, unknown> }>("/api/v1/agent-persona", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const positionId = int(body.position_id);
    if (positionId <= 0) return reply.code(422).send({ detail: "position_id is required" });
    if (!positionExists(positionId)) return reply.code(422).send({ detail: "position not found" });

    const content = text(body.content);
    if (content.length > MAX_PERSONA_CHARS) {
      return reply.code(422).send({ detail: `人设不能超过 ${MAX_PERSONA_CHARS} 字` });
    }
    // 允许存空串：新岗位刚建时先落一条空人设，前端就能显示「未配置」而不是 404。
    const status = text(body.status).trim() || "enabled";
    if (!["enabled", "disabled"].includes(status)) {
      return reply.code(422).send({ detail: "status must be enabled or disabled" });
    }

    const row = db
      .prepare(
        `INSERT INTO agent_persona(position_id, content, status, created_at, updated_at)
         VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
         ON CONFLICT(position_id) DO UPDATE SET
           content=excluded.content,
           status=excluded.status,
           updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
      )
      .get(positionId, content, status) as PersonaRow;
    return serializePersona(row);
  });

  // ── 开场：追加 ────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent-opening", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const body = request.body ?? {};
    const positionId = int(body.position_id);
    if (positionId <= 0) return reply.code(422).send({ detail: "position_id is required" });
    if (!positionExists(positionId)) return reply.code(422).send({ detail: "position not found" });

    const count = Number(
      (
        db.prepare("SELECT COUNT(*) AS n FROM position_opening WHERE position_id=?").get(positionId) as {
          n: number;
        }
      ).n ?? 0,
    );
    if (count >= MAX_OPENINGS) {
      return reply.code(422).send({ detail: `一个岗位最多 ${MAX_OPENINGS} 条开场` });
    }

    const kind = text(body.kind).trim() || "text";
    const invalid = validateOpening(db, body, kind);
    if (invalid) return reply.code(422).send({ detail: invalid });

    const nextSeq = Number(
      (
        db
          .prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM position_opening WHERE position_id=?")
          .get(positionId) as { seq: number }
      ).seq ?? 1,
    );
    const row = db
      .prepare(
        `INSERT INTO position_opening(position_id, seq, kind, content, media_name, delay_ms, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'enabled',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
         RETURNING *`,
      )
      .get(
        positionId,
        nextSeq,
        kind,
        text(body.content).trim(),
        text(body.media_name).trim(),
        clampDelay(body.delay_ms),
      ) as OpeningRow;
    return serializeOpening(db, row);
  });

  // ── 开场：改一条 ──────────────────────────────────────────────
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/v1/agent-opening/:id",
    async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const id = int(request.params.id);
      if (id <= 0) return reply.code(404).send({ detail: "Not Found" });
      const current = db.prepare("SELECT * FROM position_opening WHERE id=?").get(id) as
        | OpeningRow
        | undefined;
      if (!current) return reply.code(404).send({ detail: "Not found" });

      const body = request.body ?? {};
      const kind = text(body.kind).trim() || String(current.kind);
      const merged = {
        content: body.content === undefined ? current.content : body.content,
        media_name: body.media_name === undefined ? current.media_name : body.media_name,
      };
      const invalid = validateOpening(db, merged, kind);
      if (invalid) return reply.code(422).send({ detail: invalid });

      const status = text(body.status).trim() || String(current.status);
      if (!["enabled", "disabled"].includes(status)) {
        return reply.code(422).send({ detail: "status must be enabled or disabled" });
      }

      const row = db
        .prepare(
          `UPDATE position_opening SET
             kind=?, content=?, media_name=?, delay_ms=?, status=?, updated_at=CURRENT_TIMESTAMP
           WHERE id=?
           RETURNING *`,
        )
        .get(
          kind,
          text(merged.content).trim(),
          text(merged.media_name).trim(),
          body.delay_ms === undefined ? Number(current.delay_ms) : clampDelay(body.delay_ms),
          status,
          id,
        ) as OpeningRow;
      return serializeOpening(db, row);
    },
  );

  // ── 开场：删一条 ──────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/v1/agent-opening/:id", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const id = int(request.params.id);
    if (id <= 0) return reply.code(404).send({ detail: "Not Found" });
    const result = db.prepare("DELETE FROM position_opening WHERE id=?").run(id);
    if (Number(result.changes ?? 0) === 0) return reply.code(404).send({ detail: "Not found" });
    return { ok: true };
  });


  app.post<{ Body: Record<string, unknown> }>("/api/v1/agent-opening/batch-delete", async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
    const { position_id: positionId, ids, revision } = request.body ?? {};
    if (typeof positionId !== "number" || !Number.isSafeInteger(positionId) || positionId <= 0 ||
        !Array.isArray(ids) || !ids.length || ids.length > MAX_OPENINGS ||
        ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length ||
        typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)) {
      return reply.code(422).send({ detail: "请选择当前岗位的开场条目后重试" });
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const items = listOpenings(positionId);
      const selected = new Set<number>(ids);
      const remaining = items.filter(item => !selected.has(item.id));
      if (openingRevision(items) !== revision) {
        db.exec("ROLLBACK");
        return reply.code(409).send({ detail: "开场列表已更新，请重新勾选" });
      }
      if (items.length - remaining.length !== ids.length) {
        db.exec("ROLLBACK");
        return reply.code(422).send({ detail: "所选条目不全属于当前岗位" });
      }
      db.prepare(
        "DELETE FROM position_opening WHERE position_id=? AND id IN (SELECT value FROM json_each(?))",
      ).run(positionId, JSON.stringify(ids));
      db.exec("COMMIT");
      return { deleted_count: ids.length, items: remaining, opening_revision: openingRevision(remaining) };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });

  // ── 开场：重排 ────────────────────────────────────────────────
  // 前端上移/下移后把完整 id 顺序发过来，这里在一个事务里重写 seq。
  // 只接受该岗位自己的 id：混进别的岗位会让两个岗位的 seq 交叉，排序彻底乱掉。
  app.post<{ Body: Record<string, unknown> }>(
    "/api/v1/agent-opening/reorder",
    async (request, reply) => {
      if (!isAdmin(request)) return reply.code(403).send(ADMIN_REQUIRED);
      const body = request.body ?? {};
      const positionId = int(body.position_id);
      if (positionId <= 0) return reply.code(422).send({ detail: "position_id is required" });
      const ids = Array.isArray(body.ids) ? body.ids.map((value) => int(value)) : [];
      if (!ids.length) return reply.code(422).send({ detail: "ids is required" });
      if (new Set(ids).size !== ids.length) {
        return reply.code(422).send({ detail: "ids 有重复项" });
      }

      const owned = new Set(
        (
          db.prepare("SELECT id FROM position_opening WHERE position_id=?").all(positionId) as Array<{
            id: number;
          }>
        ).map((row) => Number(row.id)),
      );
      if (ids.some((id) => !owned.has(id))) {
        return reply.code(422).send({ detail: "ids 包含不属于该岗位的条目" });
      }

      db.exec("BEGIN");
      try {
        const update = db.prepare(
          "UPDATE position_opening SET seq=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        );
        ids.forEach((id, index) => update.run(index + 1, id));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        return reply.code(500).send({ detail: `重排失败：${(error as Error).message}` });
      }
      return { items: listOpenings(positionId) };
    },
  );
}
