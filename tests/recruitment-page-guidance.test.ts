import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("city template prefill in the position form", () => {
  it("clears old defaults absent from the next city while preserving user edits", async () => {
    const input = (value = "") => ({ value, dataset: {} as Record<string, string>, dispatchEvent: () => true });
    const salary = input();
    const address = input();
    const note = { textContent: "" };
    const selectedCity = { textContent: "城市A" };
    const cityItem = {
      querySelector: (selector: string) => selector === ".el-form-item__label"
        ? { textContent: "所属城市" }
        : selectedCity,
    };
    const items = [
      cityItem,
      ...[["薪资详情", salary], ["面试/工作地址", address]].map(([label, field]) => ({
        querySelector: (selector: string) => selector === ".el-form-item__label"
          ? { textContent: label }
          : field,
      })),
    ];
    const events: Record<string, () => Promise<void>> = {};
    const drawer = {
      dataset: {} as Record<string, string>, isConnected: true,
      querySelectorAll: () => items,
      querySelector: () => note,
      addEventListener: (event: string, handler: () => Promise<void>) => { events[event] = handler; },
    };
    const source = readFileSync("public/theme/recruitment-page-guidance.js", "utf8");
    const start = source.indexOf("  async function bindCityTemplate(");
    const end = source.indexOf("\n  function run()", start);
    const context = vm.createContext({
      NOTE_ATTR: "data-rk-recruitment-note",
      localStorage: { getItem: () => "test-token" },
      MutationObserver: class { observe() {} },
      setInputValue: (field: typeof salary, value: string) => { field.value = value; },
      fetch: async () => ({ ok: true, json: async () => ({ items: [
        { city_name: "城市A", salary: { raw: "22元/小时" }, interview: { location: "A面试点" } },
        { city_name: "城市B", salary: { raw: "25元/小时" }, interview: {} },
      ] }) }),
    });
    vm.runInContext(`${source.slice(start, end)}\nthis.bindCityTemplate = bindCityTemplate;`, context);
    await context.bindCityTemplate(drawer);
    await events.change();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(address.value).toBe("A面试点");
    salary.value = "用户填写的工资";
    selectedCity.textContent = "城市B";
    await events.change();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(address.value).toBe("");
    expect(salary.value).toBe("用户填写的工资");
  });
});
