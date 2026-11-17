// ts-morph 摘除混合测试文件里的死用例（按 it 标题）
import { Project, SyntaxKind } from "ts-morph";

const JOBS = {
  "tests/phase-two.test.ts": [
    "tests a device's own Dify connection against its stored dify_url/dify_key",
    "rejects test-dify for a device that has no dify_url configured",
    "404s test-dify for an unknown device id",
    "moves an activation record through approval and sending",
  ],
  "tests/device-config.test.ts": [
    "upserts device scripts by (device_code, stage, city) and supports list/delete",
  ],
  "tests/city-links-form.test.ts": [
    "allows Guangzhou to find only the bound factory's intercity jobs",
  ],
  "tests/generic-contracts.test.ts": [
    "serves settings, knowledge, activation and agent list contracts",
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
      if (stmt) {
        stmt.remove();
        total++;
      }
      break;
    }
  }
}
await project.save();
console.log(`已摘除 ${total} 个用例`);
