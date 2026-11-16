import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { canAccessCity, getUserScope } from "../../auth/user-scopes.js";
import { serializeFactory } from "../../shared/response-serializers.js";

type Position = { id: number; city_id: number; factory_id: number | null; data_json: string };

// 独立更新归属，避免旧岗位表单的全量 data_json 写法抹掉工资、面试点等资料。
export function registerPositionFactoryRoutes(app: FastifyInstance, db: DatabaseSync) {
  const find = (id: string) => db.prepare("SELECT id,city_id,factory_id,data_json FROM service_positions WHERE id=?").get(Number(id)) as Position | undefined;
  const visible = (position: Position | undefined, auth: NonNullable<import("fastify").FastifyRequest["auth"]>) => position && canAccessCity(getUserScope(db, auth), position.city_id);
  const result = (position: Position) => {
    const city = db.prepare("SELECT city_name FROM cities WHERE id=?").get(position.city_id) as { city_name: string };
    const factory = db.prepare("SELECT factory_name FROM factories WHERE id=?").get(position.factory_id) as { factory_name: string } | undefined;
    const factories = db.prepare("SELECT * FROM factories WHERE city_id=? ORDER BY id").all(position.city_id) as Array<Record<string, unknown>>;
    return { position_id: position.id, city_id: position.city_id, city_name: city.city_name, factory_id: position.factory_id, factory_name: factory?.factory_name ?? "", factories: factories.map(serializeFactory) };
  };

  app.get<{ Params: { id: string } }>("/api/v1/service-positions/:id/factory-binding", async (request, reply) => {
    const position = find(request.params.id);
    if (!visible(position, request.auth!)) return reply.code(404).send({ detail: "岗位不存在" });
    return result(position!);
  });

  app.put<{ Params: { id: string }; Body: { factory_id?: unknown } }>("/api/v1/service-positions/:id/factory-binding", async (request, reply) => {
    const position = find(request.params.id);
    if (!visible(position, request.auth!)) return reply.code(404).send({ detail: "岗位不存在" });
    const factoryId = request.body?.factory_id;
    if (factoryId !== null && (typeof factoryId !== "number" || !Number.isSafeInteger(factoryId) || factoryId <= 0)) {
      return reply.code(422).send({ detail: "请选择工厂，或明确取消归属" });
    }
    let factoryName = "";
    if (factoryId !== null) {
      const factory = db.prepare("SELECT * FROM factories WHERE id=? AND city_id=?").get(factoryId as number, position!.city_id) as Record<string, unknown> | undefined;
      if (!factory) return reply.code(422).send({ detail: "请选择岗位所属城市下的工厂" });
      if (!serializeFactory(factory).is_active || factory.status !== "enabled") return reply.code(422).send({ detail: "该工厂已停用，请先启用工厂" });
      factoryName = String(factory.factory_name);
    }
    const data = JSON.parse(position!.data_json || "{}") as Record<string, unknown>;
    // 同步旧表单的显示字段；实际筛选始终使用 SQL 列 factory_id。
    Object.assign(data, { factory_id: factoryId, store_name: factoryName });
    db.prepare("UPDATE service_positions SET factory_id=?,data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(factoryId as number | null, JSON.stringify(data), position!.id);
    return result(find(request.params.id)!);
  });
}
