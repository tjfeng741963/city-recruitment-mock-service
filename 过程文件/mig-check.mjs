import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "../src/db/migrate.ts";
const db = new DatabaseSync(":memory:");
migrateDatabase(db);
const has = (name) => db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name=?").get(name).n;
console.log("flow_nodes table:", has("flow_nodes"));
console.log("flow_edges table:", has("flow_edges"));
console.log("flow_nodes rows:", db.prepare("SELECT COUNT(*) n FROM flow_nodes").get().n);
console.log("versions>=29:", db.prepare("SELECT version FROM schema_migrations WHERE version>=29 ORDER BY version").all().map(r=>r.version).join(","));
