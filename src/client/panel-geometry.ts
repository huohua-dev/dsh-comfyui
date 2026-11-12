/** Keep the floating panel's height constrained when movement removes its
 * bottom anchor, including positions saved before the first resize. */
export interface PanelGeom {
  x?: number
  y?: number
  width?: number
  height?: number
}

export function movedPanelGeometry(geom: PanelGeom, pos: { x: number; y: number }, measuredHeight: number): PanelGeom {
  return { ...geom, ...pos, height: geom.height ?? measuredHeight }
}

export function panelGeometryStyle(geom: PanelGeom): Record<string, string> {
  const style: Record<string, string> = {}
  if (geom.x !== undefined && geom.y !== undefined) {
    style.left = `${geom.x}px`
    style.top = `${geom.y}px`
    style.right = 'auto'
    style.bottom = 'auto'
    // Old saved move-only geometry has no measured height. Recover the same
    // viewport constraint the default top/bottom anchors would have supplied.
    style.height = 'calc(100% - var(--dsc-panel-top, 9%) - var(--dsc-panel-bottom, 2%))'
  }
  if (geom.width !== undefined) style.width = `${geom.width}px`
  if (geom.height !== undefined) style.height = `${geom.height}px`
  return style
}
