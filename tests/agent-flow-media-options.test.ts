import { describe, expect, it } from "vitest";
import { availableFlowMedia, normalizeFlowMediaOptions } from "../frontend-vue/src/components/agent/flow-media-options.js";

describe("flow editor media options", () => {
  it("offers enabled API media when the list response omits its status", () => {
    const response = [
      { name: "岗位图片.png", kind: "image", position_id: 25 },
      { name: "通用图片.png", kind: "image", position_id: 0 },
      { name: "其他岗位.png", kind: "image", position_id: 22 },
      { name: "岗位视频.mp4", kind: "video", position_id: 25 },
    ];
    const normalized = normalizeFlowMediaOptions(response);
    expect(availableFlowMedia(normalized, "image", 25).map((item) => item.name))
      .toEqual(["岗位图片.png", "通用图片.png"]);
    expect(availableFlowMedia(normalized, "video", 25).map((item) => item.name))
      .toEqual(["岗位视频.mp4"]);
    expect(response[0]).not.toHaveProperty("status");
  });

  it("does not make explicitly disabled or deleted media available", () => {
    const normalized = normalizeFlowMediaOptions([
      { name: "启用.png", kind: "image", position_id: 25, status: "enabled" },
      { name: "停用.png", kind: "image", position_id: 25, status: "disabled" },
      { name: "删除.png", kind: "image", position_id: 0, status: "deleted" },
    ]);
    expect(availableFlowMedia(normalized, "image", 25).map((item) => item.name)).toEqual(["启用.png"]);
  });

  it("normalizes common-pool bindings and ignores entries without a media name", () => {
    const normalized = normalizeFlowMediaOptions([
      { name: "通用视频.mp4", kind: "video", position_id: null },
      { name: "", kind: "image", position_id: 25 },
    ]);
    expect(availableFlowMedia(normalized, "video", 25)).toEqual([
      { name: "通用视频.mp4", kind: "video", position_id: 0, status: "enabled" },
    ]);
  });
});
