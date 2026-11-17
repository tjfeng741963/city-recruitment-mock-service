// ts-morph AST 级摘除死路由：app.get/post/...("/path", ...) 调用表达式，
// 连同前置注释一起删，保证语法正确。
import { Project, SyntaxKind } from "ts-morph";

const JOBS = {
  "src/modules/agent/agent.routes.ts": [
    "get /api/v1/agent/candidates",
    "post /api/v1/agent/candidates",
    "post /api/v1/agent/candidates/:id/mark",
    "post /api/v1/agent/candidates/:id/remind",
    "get /api/v1/agent/device-scripts",
    "post /api/v1/agent/device-scripts",
    "delete /api/v1/agent/device-scripts/:id",
    "put /api/v1/agent/device-scripts/:id",
    "get /api/v1/agent/device/:id/workflow",
    "put /api/v1/agent/device/:id/workflow",
    "delete /api/v1/agent/device/:id/workflow",
    "get /api/v1/agent/invite-group",
    "put /api/v1/agent/invite-group",
    "get /api/v1/agent/invite-group/sends",
    "get /api/v1/agent/old-friends",
    "get /api/v1/agent/old-friends/accounts",
    "post /api/v1/agent/old-friends/mark",
    "put /api/v1/agent/old-friends/:id/release",
    "put /api/v1/agent/old-friends/:id/unrelease",
    "put /api/v1/agent/old-friends/:id",
    "delete /api/v1/agent/old-friends/:id",
    "get /api/v1/agent/reminder-tasks",
    "get /api/v1/agent/report/metrics",
    "post /api/v1/agent/devices/:id/test-dify",
  ],
  "src/modules/agent/kb-v3.routes.ts": [
    "get /api/v1/flow-nodes",
    "post /api/v1/flow-nodes",
    "delete /api/v1/flow-nodes/:id",
    "get /api/v1/flow-edges",
    "post /api/v1/flow-edges",
    "delete /api/v1/flow-edges/:id",
  ],
  "src/modules/agent/profile.routes.ts": [
    "get /api/v1/agent/jobs",
    "post /api/v1/agent/profile",
    "get /api/v1/agent/profile",
  ],
  "src/modules/resources/resource.routes.ts": [
    "get /api/v1/agent/evaluation/overview",
    "get /api/v1/agent/evaluation/detail",
    "post /api/v1/agent/evaluation/run",
    "get /api/v1/agent/followup-config",
    "post /api/v1/agent/followup-config",
    "get /api/v1/agent/reminder-config",
    "post /api/v1/agent/reminder-config",
    "get /api/v1/agent/report/account-summary",
    "post /api/v1/knowledge/batch/delete",
    "post /api/v1/knowledge/batch/update",
  ],
};

const project = new Project({ tsConfigFilePath: "tsconfig.json" });

let total = 0;
const missed = [];
for (const [file, routes] of Object.entries(JOBS)) {
  const sf = project.getSourceFileOrThrow(file);
  for (const spec of routes) {
    const [method, path] = spec.split(" ");
    let removed = false;
    // 遍历所有 CallExpression：callee 是 app.<method>，第一个参数是 path 字符串
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      const pa = expr.asKind(SyntaxKind.PropertyAccessExpression);
      if (!pa || pa.getExpression().getText() !== "app" || pa.getName().toLowerCase() !== method) continue;
      const arg0 = call.getArguments()[0];
      if (!arg0 || arg0.getKind() !== SyntaxKind.StringLiteral) continue;
      if (arg0.getText().slice(1, -1) !== path) continue;
      // 上溯到 ExpressionStatement，删整条语句（含前置注释）
      const stmt = call.getAncestors().find((a) => a.getKind() === SyntaxKind.ExpressionStatement);
      if (stmt) {
        const s = stmt.asKind(SyntaxKind.ExpressionStatement);
        const full = s.getLeadingCommentRanges();
        for (const c of full) s.removeRange?.call(s, [c.getPos(), c.getEnd()]);
        stmt.remove();
        removed = true;
      }
      break;
    }
    if (!removed) missed.push(`${spec} @ ${file}`);
    else total++;
  }
}

await project.save();
console.log(`摘除 ${total} 条；未匹配 ${missed.length} 条`);
for (const m of missed) console.log("  !!", m);
