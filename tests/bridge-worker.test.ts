import { afterEach, describe, expect, it } from "vitest";
// The standalone worker runs directly on Node 22 and intentionally has no server dependencies.
// @ts-expect-error standalone ESM module
import { DeviceWorker } from "../bridge/worker.mjs";

describe("device worker journal", () => {
  let worker: any;
  afterEach(() => worker?.close());
  it("sends split text once and replays a stored receipt without duplicating physical messages", async () => {
    const sent: string[] = [];
    const requests: any[] = [];
    const driver = { simulated: false, send: async (_contact: string, content: string) => { sent.push(content); return `wx-${sent.length}`; } };
    worker = new DeviceWorker({ databasePath: ":memory:", driver, request: async (action: string, payload: any) => { requests.push({ action, payload }); return {}; } });
    const command = { id: "cmd-1", lease_token: "lease-1", contact_id: "wx-contact", content: "你好###岗位详情" };
    await worker.execute(command);
    await worker.execute(command);
    expect(sent).toEqual(["你好", "岗位详情"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ action: "receipts", payload: { command_id: "cmd-1", status: "succeeded", simulated: false } });
    expect(requests[1]).toEqual(requests[0]);
  });
  it("reports an ambiguous driver failure as unknown and never automatically resends it", async () => {
    let calls = 0;
    const receipts: any[] = [];
    worker = new DeviceWorker({ databasePath: ":memory:", driver: { send: async () => { calls++; throw new Error("send result unknown"); } }, request: async (_action: string, payload: any) => { receipts.push(payload); return {}; } });
    const command = { id: "cmd-2", lease_token: "lease-2", contact_id: "wx-contact", content: "hi" };
    await worker.execute(command);
    await worker.execute(command);
    expect(calls).toBe(1);
    expect(receipts.map(r => r.status)).toEqual(["unknown", "unknown"]);
  });
  it("keeps received messages until the application accepts them, preserving original event ids", async () => {
    const requests: any[] = [];
    let fail = true;
    let now = 0;
    worker = new DeviceWorker({ databasePath: ":memory:", driver: {}, now: () => now, request: async (action: string, payload: any) => { requests.push({ action, payload }); if (fail) throw new Error("offline"); return {}; } });
    worker.receive({ event_id: "wx-in-1", contact_id: "opaque-1", content: "岗位" });
    await expect(worker.flushInbox()).rejects.toThrow("offline");
    fail = false;
    now += 2000;
    await worker.flushInbox();
    await worker.flushInbox();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  });
  it("retries a lost receipt without executing the physical send again", async () => {
    let sends = 0, fail = true;
    worker = new DeviceWorker({ databasePath: ":memory:", driver: { send: async () => { sends++; return "wx-1"; } }, request: async () => { if (fail) throw new Error("lost ack"); return {}; } });
    await expect(worker.execute({ id: "lost-ack", lease_token: "lease", contact_id: "wx", content: "hi" })).rejects.toThrow();
    fail = false;
    await worker.flushReceipts();
    expect(sends).toBe(1);
    expect(worker.db.prepare("SELECT acked FROM sends WHERE command_id='lost-ack'").get()).toMatchObject({ acked: 1 });
  });
  it("defers transient errors without dropping them or blocking the next contact", async () => {
    const ids: string[] = [];
    let now = 0;
    worker = new DeviceWorker({ databasePath: ":memory:", driver: {}, now: () => now, request: async (_action: string, payload: any) => { ids.push(payload.event_id); if (payload.event_id === "bad") throw new Error("provider unavailable"); return {}; } });
    worker.receive({ event_id: "bad", contact_id: "a", content: "x" });
    worker.receive({ event_id: "good", contact_id: "b", content: "y" });
    await worker.flushInbox().catch(() => {});
    await worker.flushInbox();
    now += 2000;
    await worker.flushInbox().catch(() => {});
    expect(ids).toEqual(["bad", "good", "bad"]);
    expect(worker.db.prepare("SELECT done FROM inbox WHERE event_id='bad'").get()).toMatchObject({ done: 0 });
  });
});
