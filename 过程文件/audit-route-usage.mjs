// 盘点前端（编译产物 + theme 脚本）实际调用的接口，与全量路由做差集。
import fs from "node:fs";

const files = [];
for (const f of fs.readdirSync("public/assets")) if (f.endsWith(".js")) files.push("public/assets/" + f);
for (const f of fs.readdirSync("public/theme")) if (f.endsWith(".js")) files.push("public/theme/" + f);
const used = new Set();
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const re = /\$?\/?api\/v1\/[a-zA-Z0-9/:._-]+/g;
  let m;
  while ((m = re.exec(src))) used.add(m[0].replace(/^\$/, ""));
}

const snap = null; // 快照已删，直接用 route-notes.ts 里沉淀的全量路由清单
const notesSrc = fs.readFileSync("src/modules/agent/route-notes.ts", "utf8");
const all = [];
const re2 = /method: "(\w+)", url: "([^"]+)"/g;
let m2;
while ((m2 = re2.exec(notesSrc))) all.push({ method: m2[1], url: m2[2] });

// 把前端调用路径归一化成路由模式（:id 等），然后比对
function matchesRoute(call, routeUrl) {
  const callSegs = call.split("/").filter(Boolean);
  const routeSegs = routeUrl.split("/").filter(Boolean);
  if (callSegs.length !== routeSegs.length) return false;
  return routeSegs.every((seg, i) =>
    seg.startsWith(":") ? true : seg === callSegs[i],
  );
}

const called = new Set();
const unmatchedCalls = [];
for (const call of used) {
  const norm = call.startsWith("/api/v1/") ? call : "/api/v1/" + call.replace(/^\/?api\/v1\//, "");
  let hit = false;
  for (const r of all) {
    if (matchesRoute(norm.replace(/\/$/, ""), r.url)) {
      hit = true;
      called.add(`${r.method} ${r.url}`);
      break;
    }
  }
  if (!hit) unmatchedCalls.push(norm);
}

console.log("前端调用的路由数（命中真实路由）:", called.size, "/", all.length);
const uncalled = all.filter((r) => !called.has(`${r.method} ${r.url}`));
console.log("前端零调用的路由:", uncalled.length);
console.log("\n=== 零调用路由（按前缀聚合）===");
const byPrefix = new Map();
for (const r of uncalled) {
  const parts = r.url.split("/").filter(Boolean);
  const prefix = "/" + parts.slice(0, 4).join("/");
  byPrefix.set(prefix, (byPrefix.get(prefix) || 0) + 1);
}
console.log([...byPrefix.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}  ${n}条`).join("\n"));
console.log("\n=== 前端调了但路由表没有的（可能是拼出来的）===", unmatchedCalls.length);
console.log(unmatchedCalls.slice(0, 12).join("\n"));
