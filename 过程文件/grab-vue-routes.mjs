// 抓 Vue 路由表：path + meta
import fs from "node:fs";
for (const f of fs.readdirSync("public/assets")) {
  if (!f.startsWith("index-")) continue;
  const src = fs.readFileSync("public/assets/" + f, "utf8");
  const routes = [];
  const re = /\{[^{}]*?path:"(\/[^"]*)"[^{}]*?\}/g;
  let m;
  while ((m = re.exec(src))) {
    const seg = m[0];
    const t = seg.match(/title:"([^"]+)"/);
    const n = seg.match(/name:"([^"]+)"/);
    routes.push(`${m[1].padEnd(26)} ${t ? t[1] : n ? n[1] : ""}`);
  }
  console.log(routes.join("\n"));
  break;
}
