import { describe, expect, it } from "vitest";
import { addRegistrationColumn, interviewMoment, regionText, statusLabel } from "../public/theme/candidate-registration-table.js";

/**
 * 候选人表格补列（public/theme/candidate-registration-table.js）。
 *
 * 客户要的 OA 十项里，原表缺：归属账号、面试时间、省/市/区、客户状态标签、
 * 提醒到场。这些字段接口都已返回，只是没有列。补丁只加列，不动压缩 bundle。
 */
describe("candidate table columns", () => {
  const build = () => {
    const columnType = { name: "ElTableColumn" };
    const device = { type: columnType, props: { label: "设备" } };
    const name = { type: columnType, props: { prop: "name" } };
    const action = { type: columnType, props: { fixed: "right" } };
    const table = { type: { name: "ElTable" }, children: { default: () => [device, name, action] } };
    const root = { children: [table] };
    const create = (type: unknown, props: unknown, slots?: unknown) => ({ type, props, slots });
    const context = (slot: unknown) => slot;
    return { table, root, create, context, device, name, action, columnType };
  };

  it("adds account right after the device column", () => {
    const { table, root, create, context, device } = build();
    addRegistrationColumn(root, create, context);
    const columns = table.children.default();
    expect(columns[0]).toBe(device);
    expect(columns[1]).toMatchObject({ type: { name: "ElTableColumn" }, props: { prop: "account", label: "归属账号" } });
  });

  it("adds interview time, region, summary, status and the remind button before actions", () => {
    const { table, root, create, context, action } = build();
    addRegistrationColumn(root, create, context);
    const columns = table.children.default();
    const labels = columns.map((column: { props?: { label?: string } }) => column.props?.label).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(["面试时间", "省/市/区", "登记摘要", "客户状态", "提醒到场"]));
    expect(columns[columns.length - 1]).toBe(action);
  });

  it("is idempotent: running the patch twice does not duplicate columns", () => {
    const { table, root, create, context } = build();
    addRegistrationColumn(root, create, context);
    const once = table.children.default().length;
    addRegistrationColumn(root, create, context);
    expect(table.children.default()).toHaveLength(once);
  });

  it("leaves unrelated elements and tables without column components alone", () => {
    const children = [null, "plain text", { type: "div", children: [] }];
    const root = { children };
    addRegistrationColumn(root, () => { throw new Error("unexpected column"); }, (slot: unknown) => slot);
    expect(root.children).toBe(children);
  });
});

describe("candidate column formatters", () => {
  it("renders interview moment with date and time, falling back to date only", () => {
    expect(interviewMoment({ interview_date: "2026-11-09", interview_time: "09:00-11:00" })).toBe("2026-11-09 09:00-11:00");
    expect(interviewMoment({ interview_date: "2026-11-09" })).toBe("2026-11-09");
    expect(interviewMoment({})).toBe("-");
  });

  it("joins province, city and district while skipping missing levels", () => {
    expect(regionText({ province: "广东省", city: "广州", district: "番禺" })).toBe("广东省/广州/番禺");
    expect(regionText({ city: "佛山" })).toBe("佛山");
    expect(regionText({})).toBe("-");
  });

  it("maps customer status codes to the labels the customer asked for", () => {
    expect(statusLabel("invited")).toBe("报名成功");
    expect(statusLabel("disqualified")).toBe("不符合");
    expect(statusLabel("checked_in")).toBe("已签到");
    expect(statusLabel("something_new")).toBe("something_new");
    expect(statusLabel("")).toBe("-");
  });
});
