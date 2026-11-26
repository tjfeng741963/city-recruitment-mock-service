import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./connection.js";
import { initializeSharedOpenings, restoreLegacyFlowOpenings } from "../modules/agent/shared-opening.js";
import { resolveDeviceInviteGroup } from "../shared/invite-group.js";

function migrateLegacyAgentNotificationGroups(db: DatabaseSync): void {
  const devices = db.prepare(`SELECT d.id,b.device_code,json_extract(d.data_json,'$.group_chat') AS binding
    FROM agent_devices d JOIN bridge_devices b ON b.device_code=json_extract(d.data_json,'$.device_code')
    LEFT JOIN reply_mode_transition r ON r.device_code=b.device_code
    WHERE d.status='enabled' AND b.account_id<>''
      AND COALESCE(r.effective,json_extract(d.data_json,'$.reply_provider'),'agent')='agent'
      AND EXISTS (SELECT 1 FROM device_group_chats g WHERE g.device_code=b.device_code)`).all() as
      Array<{id:number;device_code:string;binding:unknown}>;
  const update = db.prepare("UPDATE agent_devices SET data_json=json_set(data_json,'$.group_chat',?) WHERE id=?");
  for (const device of devices) {
    const binding = typeof device.binding === "string" ? device.binding.trim() : "";
    if (!binding || binding.startsWith("R:")) continue;
    const group = resolveDeviceInviteGroup(db, device.device_code, binding);
    if (group) update.run(group.conv_id, device.id);
  }
}

export function migrateDatabase(db: DatabaseSync): void {
  const migrationDirectory = path.resolve(process.cwd(), "src", "db", "migrations");
  const files = fs.readdirSync(migrationDirectory).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.exec("BEGIN");
  try {
    for (const file of files) {
      const version = Number(file.slice(0, file.indexOf("_")));
      const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
      if (!applied) {
        db.exec(fs.readFileSync(path.join(migrationDirectory, file), "utf8"));
        if (file === "065_shared_agent_opening.sql") initializeSharedOpenings(db);
        if (file === "067_device_group_snapshots.sql") migrateLegacyAgentNotificationGroups(db);
        db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDatabase(process.env.REA_DATABASE_PATH);
  try {
    if (process.argv[2] === "--restore-legacy-flow-openings") {
      db.exec("BEGIN IMMEDIATE");
      try {
        const count = restoreLegacyFlowOpenings(db);
        db.exec("COMMIT");
        console.log(`restored legacy opening nodes for ${count} flows`);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else {
      migrateDatabase(db);
      console.log("migrations applied");
    }
  } finally {
    db.close();
  }
}
