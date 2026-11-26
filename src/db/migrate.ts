import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./connection.js";
import { initializeSharedOpenings, restoreLegacyFlowOpenings } from "../modules/agent/shared-opening.js";

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
