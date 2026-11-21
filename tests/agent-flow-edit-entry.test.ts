import { describe, expect, it } from "vitest";
import { drawerTabForLoad } from "../frontend-vue/src/components/agent/flow-edit-entry.js";

describe("flow editing entry points", () => {
  it("uses the requested tab when opening the drawer and defaults to persona", () => {
    expect(drawerTabForLoad("persona", "opening", true)).toBe("opening");
    expect(drawerTabForLoad("opening", undefined, true)).toBe("persona");
  });

  it("preserves the current tab when a save, reorder or delete reloads the data", () => {
    expect(drawerTabForLoad("opening", "persona", false)).toBe("opening");
  });

});
