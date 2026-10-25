import { describe, expect, it } from "vitest";
// @ts-expect-error browser ES module
import { createManualReplySender } from "../public/assets/manual-reply.js";
describe("manual reply client intent", () => {
  it("preserves its send id after a timeout and a page reload, then clears it on success", async () => {
    const values = new Map();
    const storage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    const keys: string[] = [];
    let fail = true;
    const api = { post: async (_url: string, _body: object, config: any) => { keys.push(config.headers['Idempotency-Key']); if (fail) throw new Error("timeout"); return { data: { id: 1 } }; } };
    const send = createManualReplySender(api, storage, () => "intent-1");
    await expect(send("d", 1, "hello")).rejects.toThrow();
    fail = false;
    const reloaded = createManualReplySender(api, storage, () => "intent-2");
    await reloaded("d", 1, "hello");
    await reloaded("d", 1, "hello");
    expect(keys).toEqual(["intent-1", "intent-1", "intent-2"]);
  });
});
