// GPUI mouse-down bounds are window-relative logical pixels. The native
// overlay host clamps this requested anchor to the window edges.
export function popoverAnchor(event, width, align = 'start') {
  const b = event?.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return 'pointer';
  return { x: Math.max(0, align === 'end' ? b.x + b.width - width : b.x), y: b.y + b.height + 6 };
}
