// 菜单标题抓取
import fs from "node:fs";
for (const f of fs.readdirSync("public/assets")) {
  if (!f.startsWith("index-")) continue;
  const src = fs.readFileSync("public/assets/" + f, "utf8");
  const titles = new Set();
  for (const m of src.matchAll(/title:\s*"([\u4e00-\u9fa5A-Za-z ·]{2,14})"/g)) titles.add(m[1]);
  console.log([...titles].join(" | "));
  break;
}
