import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/check-wecom-favorite-location.mjs", import.meta.url));
const card = { kind: "location", title: "广汽本田龙华店", address: "收藏卡上的地址" };
const input = {
  expected_account_id: "account-1",
  favorite_title: card.title,
  snapshot: { account_id: "account-1", complete: true, items: [card] },
};

function runCheck(payload: unknown) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (!result.stdout) throw new Error(result.stderr || "匹配程序未返回结果");
  return { exitCode: result.status, body: JSON.parse(result.stdout) };
}

describe("企微收藏位置卡匹配", () => {
  it("只认完整标题和位置卡类型，返回收藏卡自身的地址", () => {
    expect(runCheck({
      ...input,
      favorite_title: `  ${card.title} `,
      snapshot: {
        ...input.snapshot,
        items: [
          { kind: "other", title: card.title },
          { ...card, title: `${card.title}南门` },
          card,
        ],
      },
    })).toEqual({ exitCode: 0, body: { status: "matched", title: card.title, address: card.address } });
  });

  it("接受同一个标题的 Unicode 等价写法", () => {
    const location = { ...card, title: "Café 面试点" };
    expect(runCheck({
      ...input,
      favorite_title: location.title.normalize("NFD"),
      snapshot: { ...input.snapshot, items: [location] },
    })).toEqual({ exitCode: 0, body: { status: "matched", title: location.title, address: location.address } });
  });

  it("允许空格、全半角、大小写等书写差异，但相同搜索键的多张卡仍需核对", () => {
    const location = { ...card, title: "A区 · 广汽本田龙华店(北门)" };
    const payload = { ...input, favorite_title: "ａ区 广汽本田龙华店（北门）",
      snapshot: { ...input.snapshot, items: [location] } };
    expect(runCheck(payload)).toEqual({ exitCode: 0, body: { status: "matched", title: location.title, address: location.address } });
    expect(runCheck({ ...payload, snapshot: { ...payload.snapshot, items: [location, { ...location, title: "A区广汽本田龙华店 · 北门" }] } }))
      .toEqual({ exitCode: 1, body: { status: "ambiguous" } });
  });

  it.each([
    ["not_found", { ...input, favorite_title: "广汽本田龙华电" }],
    ["not_found", { ...input, snapshot: { ...input.snapshot, items: [{ ...card, kind: "other" }] } }],
    ["ambiguous", { ...input, snapshot: { ...input.snapshot, items: [card, { ...card }] } }],
    ["account_mismatch", { ...input, snapshot: { ...input.snapshot, account_id: "account-2" } }],
    ["incomplete_results", { ...input, snapshot: { ...input.snapshot, complete: false } }],
  ])("对 %s 停止匹配", (status, payload) => {
    expect(runCheck(payload)).toEqual({ exitCode: 1, body: { status } });
  });

  it("结果里有无法识别的类型时不返回可能错误的唯一卡片", () => {
    expect(runCheck({
      ...input,
      snapshot: { ...input.snapshot, items: [card, { ...card, kind: "unknown" }] },
    })).toEqual({ exitCode: 2, body: { status: "invalid_input" } });
  });

  it("拒绝空的收藏名称和无法读取的输入", () => {
    expect(runCheck({ ...input, favorite_title: "  " })).toEqual({
      exitCode: 2, body: { status: "invalid_input" },
    });
    expect(runCheck(undefined)).toEqual({ exitCode: 2, body: { status: "invalid_input" } });
  });
});
