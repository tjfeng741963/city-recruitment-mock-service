// 检查云端设备心跳与登录二维码
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("C:/Users/a2436/Desktop/code/city-recruitment-mock-service/data/app.sqlite");
console.log("bridge_devices:", JSON.stringify(db.prepare("SELECT device_code, state, heartbeat_at FROM bridge_devices WHERE device_code='AG-SZDT01'").all()));
db.close();

const login = await fetch("http://127.0.0.1:8080/api/v1/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "local-admin", password: "local-demo-only" }),
}).then((r) => r.json());
const headers = { authorization: "Bearer " + login.access_token };

const devices = await fetch("http://127.0.0.1:8080/api/v1/agent/devices", { headers }).then((r) => r.json());
const cloud = (devices.items || []).find((d) => d.device_code === "AG-SZDT01");
console.log("设备状态:", cloud ? JSON.stringify({ device_code: cloud.device_code, online: cloud.online, position_id: cloud.position_id, last_online: cloud.last_online }) : "未找到");

const qr = await fetch("http://127.0.0.1:8080/api/v1/agent/devices/AG-SZDT01/login-qr", { headers }).then((r) => r.json());
if (qr.available) {
  console.log("二维码: 已上传 ✓ 大小", qr.width + "x" + qr.height, "截取时间", qr.captured_at);
  console.log("图片前 60 字符:", qr.image.slice(0, 60));
} else {
  console.log("二维码: 尚未上传（客户端下一轮 30 秒内会推）");
}
