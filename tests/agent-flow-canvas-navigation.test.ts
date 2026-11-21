import { describe, expect, it } from "vitest";
import { fitCanvasZoom, panCanvasScroll, zoomCanvasAt } from "../frontend-vue/src/components/agent/canvas-navigation.js";

describe("flow canvas navigation", () => {
  it("keeps the graph point under the zoom anchor in the same viewport position", () => {
    const result = zoomCanvasAt({ zoom: 0.5, nextZoom: 1, scrollLeft: 200, scrollTop: 100, anchorX: 100, anchorY: 80 });
    expect(result).toEqual({ zoom: 1, scrollLeft: 500, scrollTop: 280 });
    expect((200 + 100) / 0.5).toBe((result.scrollLeft + 100) / result.zoom);
    expect((100 + 80) / 0.5).toBe((result.scrollTop + 80) / result.zoom);
  });

  it("limits manual zoom to 25–150 percent while keeping scroll offsets nonnegative", () => {
    expect(zoomCanvasAt({ zoom: 1, nextZoom: 2, scrollLeft: 0, scrollTop: 0, anchorX: 100, anchorY: 100 }).zoom).toBe(1.5);
    expect(zoomCanvasAt({ zoom: 1, nextZoom: 0, scrollLeft: 0, scrollTop: 0, anchorX: 100, anchorY: 100 }))
      .toEqual({ zoom: 0.25, scrollLeft: 0, scrollTop: 0 });
  });

  it("keeps zoom anchored when a fitted scene starts centered in a wider viewport", () => {
    const result = zoomCanvasAt({
      zoom: 0.5, nextZoom: 1, scrollLeft: 0, scrollTop: 0, anchorX: 500, anchorY: 300,
      originX: 250, originY: 150, nextOriginX: 0, nextOriginY: 0,
    });
    expect(result).toEqual({ zoom: 1, scrollLeft: 0, scrollTop: 0 });
  });

  it("fits a long graph below the manual zoom floor instead of cutting off nodes", () => {
    const zoom = fitCanvasZoom({ width: 800, height: 10000 }, { width: 1000, height: 600 });
    expect(zoom).toBeCloseTo(0.0568);
    expect(10000 * zoom).toBeLessThanOrEqual(600 - 32);
    expect(800 * zoom).toBeLessThanOrEqual(1000 - 32);
  });

  it("fits ordinary graphs without enlarging and handles an unmeasured viewport", () => {
    expect(fitCanvasZoom({ width: 400, height: 300 }, { width: 1000, height: 600 })).toBe(1);
    expect(fitCanvasZoom({ width: 400, height: 300 }, { width: 0, height: 0 })).toBe(1);
  });

  it("moves the viewport opposite the background drag without changing graph coordinates", () => {
    expect(panCanvasScroll({ left: 200, top: 160 }, { x: 100, y: 80 }, { x: 140, y: 110 }))
      .toEqual({ left: 160, top: 130 });
    expect(panCanvasScroll({ left: 20, top: 10 }, { x: 100, y: 80 }, { x: 140, y: 110 }))
      .toEqual({ left: 0, top: 0 });
  });
});
