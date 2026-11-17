// 第二轮：摘混合测试文件里依赖死路由的用例
import { Project, SyntaxKind } from "ts-morph";

const JOBS = {
  "tests/relations-and-batch.test.ts": [
    "persists an agent workflow and exposes report metrics",
  ],
  "tests/user-scopes.test.ts": [
    "does not expose an unassigned city or device by guessed detail ID",
    "blocks candidate status changes outside the assigned device scope",
  ],
};

const project = new Project({ tsConfigFilePath: "tsconfig.json", skipAddingFilesFromTsConfig: true });
for (const file of Object.keys(JOBS)) project.addSourceFileAtPath(file);
let total = 0;
for (const [file, titles] of Object.entries(JOBS)) {
  const sf = project.getSourceFileOrThrow(file);
  for (const title of titles) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.Identifier || expr.getText() !== "it") continue;
      const arg0 = call.getArguments()[0];
      if (!arg0 || arg0.getKind() !== SyntaxKind.StringLiteral) continue;
      if (arg0.getText().slice(1, -1) !== title) continue;
      const stmt = call.getAncestors().find((a) => a.getKind() === SyntaxKind.ExpressionStatement);
      if (stmt) { stmt.remove(); total++; }
      break;
    }
  }
}
await project.save();
console.log(`已摘除 ${total} 个用例`);
