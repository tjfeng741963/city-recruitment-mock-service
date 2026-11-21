import { describe, expect, it } from "vitest";
import { drawerTabForLoad, runtimeEditEntries } from "../frontend-vue/src/components/agent/flow-edit-entry.js";

describe("flow editing entry points", () => {
  it("uses the requested tab when opening the drawer and defaults to persona", () => {
    expect(drawerTabForLoad("persona", "opening", true)).toBe("opening");
    expect(drawerTabForLoad("opening", "flow", true)).toBe("flow");
    expect(drawerTabForLoad("opening", undefined, true)).toBe("persona");
  });

  it("preserves the current tab when a save, reorder or delete reloads the data", () => {
    expect(drawerTabForLoad("opening", "persona", false)).toBe("opening");
    expect(drawerTabForLoad("flow", "opening", false)).toBe("flow");
    expect(drawerTabForLoad("persona", "flow", false)).toBe("persona");
  });

  it("offers an opening edit only for actual legacy opening nodes", () => {
    expect(runtimeEditEntries({ node_key: "legacy_3", node_type: "video" }, true, false))
      .toEqual(["edit-opening"]);
    expect(runtimeEditEntries({ node_key: "legacy_0", node_type: "text" }, true, false)).toEqual([]);
    expect(runtimeEditEntries({ node_key: "legacy_3extra", node_type: "text" }, true, false)).toEqual([]);
    expect(runtimeEditEntries({ node_key: "legacy_3", node_type: "text" }, false, false)).toEqual([]);
  });

  it("routes presentation stages to their source editors without treating them as executable nodes", () => {
    expect(runtimeEditEntries({ node_key: "__runtime_media_0", node_type: "system_media" }, false, true))
      .toEqual(["manage-media"]);
    expect(runtimeEditEntries({ node_key: "__runtime_ai", node_type: "system_ai" }, false, true))
      .toEqual(["edit-persona", "manage-knowledge"]);
    expect(runtimeEditEntries({ node_key: "__runtime_start", node_type: "system_start" }, false, true))
      .toEqual([]);
    expect(runtimeEditEntries({ node_key: "intro", node_type: "text" }, false, true))
      .toEqual(["edit-node"]);
    expect(runtimeEditEntries(null, false, true)).toEqual([]);
  });
});
