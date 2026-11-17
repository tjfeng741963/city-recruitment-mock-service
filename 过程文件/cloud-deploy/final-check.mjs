// 终验：dify 清理 + 设备接口一致性 + 二维码
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/a2436/Desktop/code/city-recruitment-mock-service/data/app.sqlite");
const rows = db.prepare("SELECT id, data_json FROM agent_devices").all();
let difyLeft = 0;
for (const r of rows) {
  const has = /dify/i.test(r.data_json || "");
  if (has) difyLeft++;
  const dj = JSON.parse(r.data_json || "{}");
  console.log("设备", r.id, dj.device_code, "→ dify 残留:", has, "→ factory_ids:", JSON.stringify(dj.factory_ids), "position_id:", dj.position_id);
}
console.log("data_json 含 dify 的设备数:", difyLeft);
db.close();

const login = await fetch("http://127.0.0.1:8080/api/v1/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
}).then((r) => r.json());
const headers = { authorization: "Bearer " + login.access_token };
const devices = await fetch("http://127.0.0.1:8080/api/v1/agent/devices", { headers }).then((r) => r.json());
const cloud = (devices.items || []).find((d) => d.device_code === "AG-SZDT01");
const difyKeys = cloud ? Object.keys(cloud).filter((k) => /dify/i.test(k)) : ["(设备未找到)"];
console.log("设备接口 dify 字段:", difyKeys.length ? difyKeys.join(",") : "无 ✓");
console.log("设备数据:", JSON.stringify({ device_code: cloud?.device_code, position_id: cloud?.position_id, online: cloud?.online, factory_ids: cloud?.factory_ids }));
const qr = await fetch("http://127.0.0.1:8080/api/v1/agent/devices/AG-SZDT01/login-qr", { headers }).then((r) => r.json());
console.log("二维码:", qr.available ? `可用 ✓ ${qr.captured_at}` : "等待推送");
