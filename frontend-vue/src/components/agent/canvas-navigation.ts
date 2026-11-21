export function fitCanvasZoom(scene: { width: number; height: number }, viewport: { width: number; height: number }): number {
  if (viewport.width <= 32 || viewport.height <= 32 || scene.width <= 0 || scene.height <= 0) return 1
  return Math.min(1, (viewport.width - 32) / scene.width, (viewport.height - 32) / scene.height)
}

export function zoomCanvasAt(input: {
  zoom: number; nextZoom: number; scrollLeft: number; scrollTop: number; anchorX: number; anchorY: number
  originX?: number; originY?: number; nextOriginX?: number; nextOriginY?: number
}): { zoom: number; scrollLeft: number; scrollTop: number } {
  const previous = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1
  const zoom = Math.max(0.25, Math.min(1.5, Number.isFinite(input.nextZoom) ? input.nextZoom : previous))
  return {
    zoom,
    scrollLeft: Math.max(0, (input.scrollLeft + input.anchorX - (input.originX ?? 0)) * zoom / previous + (input.nextOriginX ?? 0) - input.anchorX),
    scrollTop: Math.max(0, (input.scrollTop + input.anchorY - (input.originY ?? 0)) * zoom / previous + (input.nextOriginY ?? 0) - input.anchorY),
  }
}

export function panCanvasScroll(
  scroll: { left: number; top: number },
  origin: { x: number; y: number },
  current: { x: number; y: number },
): { left: number; top: number } {
  return {
    left: Math.max(0, scroll.left - (current.x - origin.x)),
    top: Math.max(0, scroll.top - (current.y - origin.y)),
  }
}
