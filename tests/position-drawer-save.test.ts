import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const drawer = readFileSync("frontend-vue/src/components/basic/PositionFormDrawer.vue", "utf8");
const start = drawer.indexOf("async function submit()");
const end = drawer.indexOf("</script>", start);
const submitScript = ts.transpileModule(drawer.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup(mode: "edit" | "create" | "copy") {
  const emit = vi.fn();
  const form = { interview_points: [], position_name: "已修改的岗位" };
  const data = { id: 7, ...form };
  const update = vi.fn(async () => ({ data }));
  const create = vi.fn();
  const formBaseline = { value: "旧表单" };
  const error = vi.fn();
  const context = {
    props: { mode, positionId: 7 },
    formRef: { value: { validate: async () => true } },
    original: { value: { id: 7 } },
    base: { value: {} },
    form,
    formBaseline,
    saving: { value: false },
    buildPayload: () => ({ position_name: form.position_name }),
    positionsApi: { update, create },
    ElMessage: { success: vi.fn(), error },
    apiErrorMessage: (_error: unknown, message: string) => message,
    emit,
  };
  const submit = runInNewContext(submitScript + "\nsubmit", context) as () => Promise<void>;
  return { emit, form, update, create, formBaseline, error, submit };
}

describe("position drawer save", () => {
  it("keeps an existing position open, updates the saved snapshot and refreshes the list", async () => {
    const { submit, emit, formBaseline, form, update } = setup("edit");
    await submit();
    expect(update).toHaveBeenCalledWith(7, { position_name: form.position_name });
    expect(formBaseline.value).toBe(JSON.stringify(form));
    expect(emit.mock.calls).toEqual([["saved"]]);
  });

  it.each(["create", "copy"] as const)("closes after saving a %s once", async (mode) => {
    const { submit, emit, create, update } = setup(mode);
    await submit();
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(emit.mock.calls).toEqual([["update:modelValue", false], ["saved"]]);
  });

  it("keeps the pending edits when the save fails", async () => {
    const { submit, emit, error, formBaseline, update } = setup("edit");
    update.mockRejectedValueOnce(new Error("write failed"));
    await submit();
    expect(error).toHaveBeenCalledWith("保存失败");
    expect(formBaseline.value).toBe("旧表单");
    expect(emit).not.toHaveBeenCalled();
  });
});
