import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { scryptSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./connection.js";
import { migrateDatabase } from "./migrate.js";
import { ACTIVATION_STRATEGY_DEFAULTS } from "../modules/activation/activation.strategies.js";

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

// 演示夹具（假厂/假岗位/假设备/假会话）只服务于本地与测试环境的列表填充，
// 生产环境默认不注入；需要显式设 REA_SEED_DEMO=1 才会写入。
// 数据本体在 demo-fixtures.json，生产部署不设置该变量即可保证库里只有真实数据。
interface DemoFixtures {
  factories: Array<[number, string, number]>;
  service_positions: Array<[number, string, number, number]>;
  knowledge_items: Array<[number, string, string]>;
  activation_strategies: Array<[number, string]>;
  activation_devices: Array<[number, string]>;
  recruiter: { id: number; username: string; city_id: number; data: Record<string, unknown>; scope_users: string[]; scope_city_id: string };
  candidate_events: Array<[number, string, string, string, string, string, string, string]>;
  old_friend_records: Array<[number, string, string, string, string, string]>;
  agent_device: { id: number; device_name: string; device_code: string; recruiter_id: string; scope_users: string[] };
  conversation: { device_code: string; customer_id: number; nickname: string; city: string; district: string; last_msg: string; unread: number };
  messages: Array<[number, string, number, string, string, string]>;
}

function seedDemoFixtures(db: DatabaseSync, seedScope: ReturnType<DatabaseSync["prepare"]>): void {
  const raw = readFileSync(new URL("./demo-fixtures.json", import.meta.url), "utf-8");
  const d = JSON.parse(raw) as DemoFixtures;
  for (const [id, factory_name, city_id] of d.factories) {
    db.prepare("INSERT OR IGNORE INTO factories(id,factory_name,city_id) VALUES (?,?,?)").run(id, factory_name, city_id);
  }
  for (const [id, position_name, factory_id, city_id] of d.service_positions) {
    db.prepare("INSERT OR IGNORE INTO service_positions(id,position_name,factory_id,city_id) VALUES (?,?,?,?)").run(id, position_name, factory_id, city_id);
  }
  for (const [id, title, content] of d.knowledge_items) {
    db.prepare("INSERT OR IGNORE INTO knowledge_items(id,title,content) VALUES (?,?,?)").run(id, title, content);
  }
  for (const [id, strategy_name] of d.activation_strategies) {
    db.prepare("INSERT OR IGNORE INTO activation_strategies(id,strategy_name) VALUES (?,?)").run(id, strategy_name);
  }
  for (const [id, device_name] of d.activation_devices) {
    db.prepare("INSERT OR IGNORE INTO activation_devices(id,device_name,status,data_json) VALUES (?,?,'enabled','{}')").run(id, device_name);
  }
  db.prepare("INSERT OR IGNORE INTO recruiters(id,username,city_id,data_json) VALUES (?,?,?,?)")
    .run(d.recruiter.id, d.recruiter.username, d.recruiter.city_id, JSON.stringify(d.recruiter.data));
  db.prepare("UPDATE users SET recruiter_id=? WHERE username IN (?,?) AND recruiter_id=''")
    .run(d.recruiter.username, ...d.recruiter.scope_users);
  for (const username of d.recruiter.scope_users) {
    seedScope.run("recruiter", d.recruiter.username, username);
    seedScope.run("city", d.recruiter.scope_city_id, username);
  }
  for (const [id, device_code, customer_id, nickname, event_type, name, phone, city] of d.candidate_events) {
    db.prepare("INSERT OR IGNORE INTO candidate_events(id,device_code,customer_id,nickname,event_type,name,phone,city,status) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, device_code, customer_id, nickname, event_type, name, phone, city, event_type);
  }
  for (const [id, account, customer_id, nickname, device_code, status] of d.old_friend_records) {
    db.prepare("INSERT OR IGNORE INTO old_friend_records(id,account,customer_id,nickname,device_code,status) VALUES (?,?,?,?,?,?)").run(id, account, customer_id, nickname, device_code, status);
  }
  db.prepare("INSERT OR IGNORE INTO agent_devices(id,device_name,status,data_json) VALUES (?,?,'enabled','{}')").run(d.agent_device.id, d.agent_device.device_name);
  const agentDevice = db.prepare("SELECT data_json FROM agent_devices WHERE id=?").get(d.agent_device.id) as { data_json: string } | undefined;
  if (agentDevice) {
    let deviceData: Record<string, unknown> = {};
    try { deviceData = JSON.parse(agentDevice.data_json) as Record<string, unknown>; } catch { deviceData = {}; }
    if (!deviceData.device_code) {
      deviceData.device_code = d.agent_device.device_code;
      deviceData.recruiter_id = d.agent_device.recruiter_id;
      db.prepare("UPDATE agent_devices SET data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(deviceData), d.agent_device.id);
    }
  }
  for (const username of d.agent_device.scope_users) seedScope.run("device", d.agent_device.device_code, username);
  db.prepare("INSERT OR IGNORE INTO agent_conversations(device_code,customer_id,nickname,city,district,last_msg,last_msg_at,unread) VALUES (?,?,?,?,?,?,?,?)")
    .run(d.conversation.device_code, d.conversation.customer_id, d.conversation.nickname, d.conversation.city, d.conversation.district, d.conversation.last_msg, new Date().toISOString(), d.conversation.unread);
  for (const [id, device_code, customer_id, direction, content, status] of d.messages) {
    db.prepare("INSERT OR IGNORE INTO agent_messages(id,device_code,customer_id,direction,content,status) VALUES (?,?,?,?,?,?)")
      .run(id, device_code, customer_id, direction, content, status);
  }
}

export function seedDatabase(db: DatabaseSync): void {
  const fixtures = [
    { username: "local-admin", role: "admin", recruiter_type: "" },
    { username: "local-customer", role: "customer", recruiter_type: "service" },
    { username: "local-recruiter", role: "recruiter", recruiter_type: "" },
  ];
  const password = process.env.REA_LOCAL_SEED_PASSWORD ?? "local-demo-only";
  for (const user of fixtures) {
    db.prepare("INSERT OR IGNORE INTO users(username,password_hash,role,recruiter_type) VALUES (?,?,?,?)")
      .run(user.username, hashPassword(password), user.role, user.recruiter_type);
  }
  const cities = [
    { id: 1, city_name: "广州", province: "广东", districts: ["天河区", "白云区", "番禺区"] },
    { id: 2, city_name: "深圳", province: "广东", districts: ["南山区", "宝安区", "龙华区"] },
    { id: 3, city_name: "东莞", province: "广东", districts: ["南城区", "长安镇", "虎门镇"] },
  ];
  for (const city of cities) {
    db.prepare("INSERT OR IGNORE INTO cities(id,city_name,province,data_json) VALUES (?,?,?,?)")
      .run(city.id, city.city_name, city.province, JSON.stringify({ districts: city.districts }));
  }
  db.prepare("INSERT OR IGNORE INTO city_links(city_id,linked_city_id) VALUES (1,2)").run();
  db.prepare("INSERT OR IGNORE INTO city_links(city_id,linked_city_id) VALUES (2,3)").run();

  const insertActivationStrategy = db.prepare("INSERT OR IGNORE INTO activation_strategy_rules(code,enabled,config_json) VALUES (?,?,?)");
  for (const strategy of ACTIVATION_STRATEGY_DEFAULTS) insertActivationStrategy.run(strategy.code, strategy.enabled ? 1 : 0, JSON.stringify(strategy.config));
  db.prepare("INSERT OR IGNORE INTO activation_config(id) VALUES (1)").run();
  const scripts = [
    [25, "有收到吗？收到回复下我呢", "寒暄召回"], [22, "这边还要找工作的么，这几天岗位都挺好的呢", "寒暄召回"], [16, "这边看的咋样啦，我们继续聊聊呗", "岗位推荐"],
  ] as const;
  for (const [id, content, category] of scripts) db.prepare("INSERT OR IGNORE INTO activation_scripts(id,script_name,content,status,data_json) VALUES (?,?,?,?,?)").run(id, category, content, "enabled", JSON.stringify({ category, is_active: true, used_count: 0 }));
  const knowledge = ["超龄", "可以不加班吗", "买社保吗", "有试用期吗", "合同签多久"]; for (const [index, question] of knowledge.entries()) db.prepare("INSERT OR IGNORE INTO knowledge_items(id,title,content,status,data_json) VALUES (?,?,?,?,?)").run(4176 + index, question, question, "enabled", JSON.stringify({ question, keywords: [], is_active: true, sort_order: 0 }));

  const seedScope = db.prepare("INSERT OR IGNORE INTO user_scope_assignments(user_id,scope_type,scope_id) SELECT id,?,? FROM users WHERE username=?");
  if (process.env.REA_SEED_DEMO === "1") seedDemoFixtures(db, seedScope);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDatabase();
  migrateDatabase(db);
  seedDatabase(db);
  db.close();
  console.log("seed data ready");
}
