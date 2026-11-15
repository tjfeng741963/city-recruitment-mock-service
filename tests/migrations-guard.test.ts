import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-migrations.mjs");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-guard-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(...names: string[]): void {
  for (const name of names) fs.writeFileSync(path.join(dir, name), "-- test migration\n");
}

function run(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, `--dir=${dir}`], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("check-migrations", () => {
  it("编号重复时以非 0 退出并逐条打印冲突文件", () => {
    write("001_init.sql", "033_old_friend_status.sql", "033_other_change.sql");
    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toContain("重复编号 033");
    expect(stderr).toContain("033_old_friend_status.sql");
    expect(stderr).toContain("033_other_change.sql");
  });

  it("合法集合以 0 退出并输出一行 OK 摘要", () => {
    write("001_init.sql", "002_agent_activation.sql", "003_permissions.sql");
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toContain("[migrations] OK: 3 files, max 003");
  });

  it("文件名不合规时以非 0 退出", () => {
    write("001_init.sql", "36_bad_prefix.sql");
    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toContain("非法文件名 36_bad_prefix.sql");
  });

  it("断号只告警，仍以 0 退出", () => {
    write("001_init.sql", "003_permissions.sql");
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toContain("断号 002");
    expect(stdout).toContain("[migrations] OK: 2 files, max 003");
  });
});
