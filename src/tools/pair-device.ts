import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "../db/connection.js";
import { migrateDatabase } from "../db/migrate.js";
import { DeviceBridgeStore } from "../modules/messaging/device-bridge.js";

const [code, filename] = process.argv.slice(2);
if (!code || !filename || !/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("Usage: pair-device <device-code> <new-env-file>");
const output = path.resolve(filename);
if (fs.existsSync(output)) throw new Error("Output exists. Choose a new path before rotating a device token.");
const db = openDatabase(process.env.REA_DATABASE_PATH);
try {
  migrateDatabase(db);
  const token = new DeviceBridgeStore(db).pair(code);
  fs.writeFileSync(output, `REA_GATEWAY_URL=http://127.0.0.1:4222\nREA_DEVICE_CODE=${code}\nREA_DEVICE_TOKEN=${token}\n`, { mode: 0o600, flag: "wx" });
  console.log(`Device paired. Private configuration saved to ${output}; token not printed.`);
} finally { db.close(); }
