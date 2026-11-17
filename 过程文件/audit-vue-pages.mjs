// 列出编译版 Vue 的页面路由与各页面的 API 消费，确定「砍接口要连带隐藏的菜单」。
import fs from "node:fs";

const assetsDir = "public/assets";
const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js")).map((f) => assetsDir + "/" + f);

// 1) 菜单/页面：在 MainLayout 里找 label 与 path 的配对
let layout = "";
for (const f of files) {
  if (f.includes("MainLayout")) { layout = fs.readFileSync(f, "utf8"); break; }
}
const menuRe = /\{[^{}]*?label:"([^"]{1,20})"[^{}]*?path:"([^"]{1,40})"[^{}]*?\}/g;
const menus = [];
let m;
while ((m = menuRe.exec(layout))) menus.push({ label: m[1], path: m[2] });
console.log("=== 菜单项（label → path）===");
console.log(menus.map((x) => `${x.label} → ${x.path}`).join("\n"));

// 2) 每个页面 chunk 消费哪些接口前缀
console.log("\n=== 页面 chunk → API 前缀 ===");
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const prefixes = new Set();
  const re = /\/api\/v1\/([a-zA-Z-]+)/g;
  let mm;
  while ((mm = re.exec(src))) prefixes.add(mm[1]);
  if (prefixes.size) {
    const name = f.split("/").pop().replace(/-[A-Za-z0-9]+\.js$/, "");
    console.log(`${name.padEnd(28)} ${[...prefixes].join(", ")}`);
  }
}
