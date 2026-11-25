import { createHash, createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { rolePreHandler } from "../../auth/rbac.js";
import { canAccessDevice, getUserScope } from "../../auth/user-scopes.js";
import type { DeviceBridgeStore } from "../messaging/device-bridge.js";

const codePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const presenceWindowMs = 60_000;
const pairingWaitMs = 120_000;
const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

type Account = { id: number; name: string; observe_only: number };
type Assignment = {
  device_code: string;
  machine_code: string | null;
  assigned_at: number | null;
  nonce: string | null;
  issued_token_hash: string | null;
  connected_at: number | null;
};

export function isCloudAgentPoolMachine(code: string) {
  return Boolean(code) && (process.env.REA_CLOUD_AGENT_POOL ?? "").split(",").some(value => value.trim() === code);
}

function account(db: DatabaseSync, code: string): Account | undefined {
  const rows = db.prepare(`
    SELECT id,device_name AS name,json_extract(data_json,'$.observe_only') AS observe_only
    FROM agent_devices WHERE status='enabled' AND json_extract(data_json,'$.device_code')=?
  `).all(code) as Account[];
  return rows.length === 1 ? rows[0] : undefined;
}

function eligibleAccount(db: DatabaseSync, code: string) {
  return codePattern.test(code) && code !== "dify-sandbox-only" && !isCloudAgentPoolMachine(code) && Boolean(account(db, code)?.observe_only)
    && !db.prepare("SELECT 1 FROM bridge_devices WHERE device_code=?").get(code)
    && !db.prepare("SELECT 1 FROM bridge_commands WHERE device_code=? AND status IN ('queued','claimed','unknown') LIMIT 1").get(code);
}

export function cloudAgentStatus(db: DatabaseSync, id: number, code: string, enabled: boolean) {
  const row = db.prepare("SELECT * FROM cloud_agent_assignments WHERE account_id=? AND device_code=?")
    .get(id, code) as Assignment | undefined;
  if (!row) return { state: enabled && eligibleAccount(db, code) ? "available" : "unavailable" };
  if (row.connected_at !== null) return { state: "connected" };
  if (row.assigned_at === null) return { state: "requested" };
  return { state: Date.now() - row.assigned_at > pairingWaitMs ? "waiting" : "assigning" };
}

function availableMachines(db: DatabaseSync) {
  const rows = db.prepare(`
    SELECT p.machine_code AS code,d.device_name AS name
    FROM cloud_agent_machine_presence p
    JOIN agent_devices d ON json_extract(d.data_json,'$.device_code')=p.machine_code
    JOIN bridge_devices b ON b.device_code=p.machine_code
    WHERE p.observed_at>=? AND d.status='enabled' AND json_extract(d.data_json,'$.observe_only')=1
      AND b.account_id='' AND b.heartbeat_at=0 AND b.token_hash=p.token_hash
      AND NOT EXISTS (SELECT 1 FROM cloud_agent_assignments a WHERE a.machine_code=p.machine_code)
    ORDER BY d.device_name,p.machine_code
  `).all(Date.now() - presenceWindowMs) as Array<{ code: string; name: string }>;
  return rows.filter(row => isCloudAgentPoolMachine(row.code) && account(db, row.code));
}

export function protectedMachineConnection(request: FastifyRequest) {
  const port = Number(process.env.REA_AGENT_SETTINGS_PORT ?? 0);
  return request.protocol === "https" ||
    (port > 0 && request.raw.socket.localPort === port &&
      request.headers["x-forwarded-proto"] === "https" &&
      `https://${request.host}` === process.env.REA_AGENT_SETTINGS_HTTPS_ORIGIN);
}

export function isAssignedCloudAgent(db: DatabaseSync, code: string) {
  return Boolean(db.prepare("SELECT 1 FROM cloud_agent_assignments WHERE device_code=? AND machine_code IS NOT NULL").get(code));
}

export function hasPendingCloudAssignment(db: DatabaseSync, code: string) {
  return Boolean(db.prepare(`
    SELECT 1 FROM cloud_agent_assignments WHERE connected_at IS NULL AND machine_code IS NOT NULL
      AND (device_code=? OR machine_code=?)
  `).get(code, code));
}

export function cloudAgentRuntime(value: unknown, state: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.wecom_available !== (state === "online") || typeof data.reply_ready !== "boolean" ||
    typeof data.reason !== "string" || !data.reason ||
    typeof data.sync !== "string" || !["unknown", "current", "catching_up", "error"].includes(data.sync) ||
    typeof data.backlog !== "number" || !Number.isSafeInteger(data.backlog) || data.backlog < 0) return null;
  return { ...data, reply_ready: false };
}

export function recordCloudAgentHeartbeat(db: DatabaseSync, code: string, token: string, state: string) {
  if (state === "offline") return;
  db.prepare(`
    UPDATE cloud_agent_assignments SET connected_at=?
    WHERE device_code=? AND issued_token_hash=? AND connected_at IS NULL
  `).run(Date.now(), code, tokenDigest(token));
}

export function registerCloudAgentAssignment(app: FastifyInstance, db: DatabaseSync, bridge: DeviceBridgeStore) {
  const admin = { preHandler: rolePreHandler("admin") };
  const path = "/api/v1/agent/cloud-agent";
  app.get(`${path}/machines`, admin, async () => ({ items: availableMachines(db) }));

  app.post<{ Params: { code: string } }>(`${path}/:code`, async (request, reply) => {
    const { code } = request.params;
    const target = account(db, code);
    if (!target || !canAccessDevice(getUserScope(db, request.auth!), code)) {
      return reply.code(404).send({ detail: "找不到可申请的微信账号" });
    }
    const current = cloudAgentStatus(db, target.id, code, true);
    if (current.state === "unavailable") return reply.code(409).send({ detail: "该账号已有客户端或无需分配云电脑" });
    if (current.state !== "available") return current;
    db.prepare(`
      INSERT INTO cloud_agent_assignments(account_id,device_code,requested_by,requested_at) VALUES (?,?,?,?)
      ON CONFLICT(account_id) DO NOTHING
    `).run(target.id, code, request.auth!.id, Date.now());
    return cloudAgentStatus(db, target.id, code, true);
  });

  app.put<{ Params: { code: string }; Body: { machine_code?: unknown } }>(`${path}/:code`, admin, async (request, reply) => {
    const { code } = request.params;
    const target = account(db, code);
    if (!target) return reply.code(404).send({ detail: "微信账号已停用或不存在" });
    const machine = request.body?.machine_code;
    const row = db.prepare("SELECT * FROM cloud_agent_assignments WHERE account_id=? AND device_code=?")
      .get(target.id, code) as Assignment | undefined;
    if (row?.machine_code && row.machine_code === machine) return cloudAgentStatus(db, target.id, code, true);
    if (!row || row.machine_code || !eligibleAccount(db, code)) {
      return reply.code(409).send({ detail: "该账号没有待处理的分配申请，或已配对或分配" });
    }
    if (typeof machine !== "string" || !availableMachines(db).some(item => item.code === machine)) {
      return reply.code(409).send({ detail: "这台云电脑已离线或被分配，请刷新后重新选择" });
    }
    const result = db.prepare(`
      UPDATE OR IGNORE cloud_agent_assignments SET machine_code=?,assigned_by=?,assigned_at=?,nonce=?
      WHERE account_id=? AND device_code=? AND machine_code IS NULL
    `).run(machine, request.auth!.id, Date.now(), randomUUID(), target.id, code);
    if (!result.changes) return reply.code(409).send({ detail: "分配状态已变化，请刷新后重试" });
    return cloudAgentStatus(db, target.id, code, true);
  });

  app.post<{ Params: { code: string } }>("/api/v1/bridge/devices/:code/cloud-assignment", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!protectedMachineConnection(request)) return reply.code(403).send({ detail: "配对需要可信 HTTPS" });
    const { code } = request.params;
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
    const machine = account(db, code);
    const status = bridge.status(code);
    if (!isCloudAgentPoolMachine(code) || !machine?.observe_only || status?.account_id || status?.heartbeat_at !== 0 || !bridge.authenticate(code, token)) {
      return reply.code(403).send({ detail: "云电脑身份无效或已在接待" });
    }
    db.prepare(`
      INSERT INTO cloud_agent_machine_presence(machine_code,token_hash,observed_at) VALUES (?,?,?)
      ON CONFLICT(machine_code) DO UPDATE SET token_hash=excluded.token_hash,observed_at=excluded.observed_at
    `).run(code, tokenDigest(token), Date.now());
    const row = db.prepare("SELECT * FROM cloud_agent_assignments WHERE machine_code=? AND connected_at IS NULL")
      .get(code) as Assignment | undefined;
    if (!row?.nonce) return { assignment: null };

    const target = account(db, row.device_code);
    if (!target || !target.observe_only || !row.issued_token_hash && !eligibleAccount(db, row.device_code)) {
      return reply.code(409).send({ detail: "目标账号无法接入试运行客户端" });
    }
    const credential = createHmac("sha256", token).update(`cloud-agent:v1:${row.nonce}:${row.device_code}`).digest("hex");
    const hash = tokenDigest(credential);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!row.issued_token_hash) {
        const inserted = db.prepare("INSERT OR IGNORE INTO bridge_devices(device_code,token_hash) VALUES (?,?)")
          .run(row.device_code, hash);
        if (inserted.changes) db.prepare("UPDATE cloud_agent_assignments SET issued_token_hash=? WHERE machine_code=? AND nonce=?")
          .run(hash, code, row.nonce);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const issued = db.prepare("SELECT issued_token_hash FROM cloud_agent_assignments WHERE machine_code=?")
      .get(code)?.issued_token_hash;
    if (issued !== hash || !bridge.authenticate(row.device_code, credential)) {
      return reply.code(409).send({ detail: "目标账号已有其他配对，请管理员核对" });
    }
    return { assignment: { id: row.nonce, device_code: row.device_code, bridge_token: credential } };
  });
}
