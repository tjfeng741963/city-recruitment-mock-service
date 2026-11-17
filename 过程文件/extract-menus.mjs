// 提取编译版 MainLayout 的菜单「路由 → 菜单名」对
import fs from "node:fs";
const src = fs.readFileSync("public/assets/MainLayout-D0ilcEhw.js", "utf8");
const re = /index:"(\/[a-z0-9-]+)"[\s\S]{0,220}?n\("span",null,"([^"]+)",-1\)/g;
const seen = {};
let m;
while ((m = re.exec(src))) {
  const route = m[1];
  const label = m[2];
  if (!seen[route]) seen[route] = label;
}
for (const [route, label] of Object.entries(seen)) {
  console.log(route.padEnd(28) + " " + label);
}
