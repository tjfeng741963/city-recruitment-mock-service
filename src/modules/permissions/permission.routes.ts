import type { FastifyInstance } from "fastify";
import { rolePreHandler } from "../../auth/rbac.js";
import { canAccessCity, getUserScope } from "../../auth/user-scopes.js";
import { serializeServicePosition } from "../../shared/response-serializers.js";

export async function registerPermissionRoutes(app: FastifyInstance) {
  app.get("/api/v1/recruiter-featured/cities", { preHandler: rolePreHandler("recruiter") }, async (request) => {
    const db = (request.server as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    const scope = getUserScope(db, request.auth!);
    const cities = db.prepare("SELECT id,city_name FROM cities ORDER BY city_name").all() as Array<{ id: number; city_name: string }>;
    const saved = new Map((db.prepare("SELECT city_id,position_ids FROM recruiter_featured").all() as Array<{ city_id: number; position_ids: string }>).map((row) => {
      let positionIds: number[] = [];
      try {
        const parsed: unknown = JSON.parse(row.position_ids);
        if (Array.isArray(parsed)) positionIds = parsed.map(Number).filter((id) => Number.isSafeInteger(id));
      } catch { /* keep an empty selection for malformed legacy data */ }
      return [Number(row.city_id), positionIds] as const;
    }));
    const items = cities.filter((city) => canAccessCity(scope, city.id)).map((city) => {
      const positionIds = saved.get(city.id) ?? [];
      const positions = db.prepare("SELECT * FROM service_positions WHERE city_id=? AND status='enabled' ORDER BY id DESC").all(city.id) as Array<Record<string, unknown>>;
      return {
        city_id: city.id,
        city_name: city.city_name,
        has_custom: saved.has(city.id),
        position_ids: positionIds,
        positions: positions.map(serializeServicePosition),
      };
    });
    return { items, total: items.length, max_featured: 3 };
  });
  app.put<{ Params: { id: string }; Body: { position_ids?: number[] } }>("/api/v1/recruiter-featured/cities/:id", { preHandler: rolePreHandler("recruiter") }, async (request, reply) => {
    const db = (request.server as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    const cityId = Number(request.params.id);
    const scope = getUserScope(db, request.auth!);
    const city = db.prepare("SELECT city_name FROM cities WHERE id=?").get(cityId) as { city_name: string } | undefined;
    if (!city || !canAccessCity(scope, cityId)) return reply.code(404).send({ detail: "City not found" });
    const requested = Array.isArray(request.body?.position_ids) ? request.body.position_ids.map(Number).filter((id) => Number.isSafeInteger(id)) : [];
    const positions = db.prepare("SELECT id FROM service_positions WHERE city_id=? AND status='enabled'").all(cityId) as Array<{ id: number }>;
    const allowed = new Set(positions.map((position) => position.id));
    const positionIds = [...new Set(requested)].filter((id) => allowed.has(id)).slice(0, 3);
    db.prepare("INSERT INTO recruiter_featured(city_id,city_name,position_ids) VALUES (?,?,?) ON CONFLICT(city_id) DO UPDATE SET city_name=excluded.city_name,position_ids=excluded.position_ids,updated_at=CURRENT_TIMESTAMP").run(cityId, city.city_name, JSON.stringify(positionIds));
    return { success: true };
  });
  app.delete<{ Params: { id: string } }>("/api/v1/recruiter-featured/cities/:id", { preHandler: rolePreHandler("recruiter") }, async (request, reply) => {
    const db = (request.server as FastifyInstance & { db: import("node:sqlite").DatabaseSync }).db;
    const cityId = Number(request.params.id);
    if (!canAccessCity(getUserScope(db, request.auth!), cityId)) return reply.code(404).send({ detail: "City not found" });
    db.prepare("DELETE FROM recruiter_featured WHERE city_id=?").run(cityId);
    return { success: true };
  });
}
