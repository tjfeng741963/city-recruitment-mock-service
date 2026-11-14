import { describe, expect, it } from "vitest";
import { addRegistrationColumn } from "../public/theme/candidate-registration-table.js";

describe("candidate registration column", () => {
  it("keeps existing columns and adds one native summary column before actions", () => {
    const columnType = { name: "ElTableColumn" };
    const name = { type: columnType, props: { prop: "name" } };
    const action = { type: columnType, props: { fixed: "right" } };
    const table = { type: { name: "ElTable" }, children: { default: () => [name, action] } };
    const root = { children: [table] };
    const create = (type: unknown, props: unknown) => ({ type, props });
    const context = (slot: unknown) => slot;
    addRegistrationColumn(root, create, context);
    addRegistrationColumn(root, create, context);
    const columns = table.children.default();
    expect(columns).toHaveLength(3);
    expect(columns[0]).toBe(name);
    expect(columns[2]).toBe(action);
    expect(columns[1]).toMatchObject({ type: columnType, props: { prop: "registration_text", label: "登记摘要", "show-overflow-tooltip": true } });
  });

  it("leaves unrelated elements and tables without column components alone", () => {
    const children = [null, "plain text", { type: "div", children: [] }];
    const root = { children };
    addRegistrationColumn(root, () => { throw new Error("unexpected column"); }, (slot: unknown) => slot);
    expect(root.children).toBe(children);
  });
});
