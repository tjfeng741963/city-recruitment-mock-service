// 本地 8080 守护启动器：detached 脱离父会话进程树，会话切换不再误杀。
// 用法：node 过程文件/daemon-8080.mjs（立即退出，服务独立运行）
// 日志：npm-dev.log（仓库根）。停服：taskkill /F /IM node.exe 太粗暴，
// 用 Get-NetTCPConnection 查 8080 的 PID 再 Stop-Process。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("npm", ["run", "dev"], {
  cwd: root,
  env: {
    ...process.env,
    REA_MESSAGE_CHANNEL_PROVIDER: "bridge",
    AGENT_LLM_API_KEY: "sk-41e328edaaa64ae7b0a7553410a1a445",
    AGENT_LLM_MODEL: "deepseek-chat",
  },
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
  shell: true,
  windowsHide: true,
});
child.unref();
console.log("8080 守护已启动（detached PID " + child.pid + "），日志看仓库根 npm-dev.log");
