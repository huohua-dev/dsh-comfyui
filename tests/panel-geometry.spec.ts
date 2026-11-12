/** Move-only panels must keep a finite height after dropping their CSS anchor. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { movedPanelGeometry, panelGeometryStyle } from '../src/client/panel-geometry.js'

describe('panel geometry', () => {
  it('preserves measured height on the first move without resizing', () => {
    const moved = movedPanelGeometry({}, { x: 8, y: 20 }, 712)
    expect(moved).toEqual({ x: 8, y: 20, height: 712 })
    expect(panelGeometryStyle(moved)).toMatchObject({ bottom: 'auto', height: '712px' })
    expect(movedPanelGeometry(moved, { x: 30, y: 40 }, 800).height).toBe(712)
  })
  it('heals old move-only saved positions and leaves defaults/resizes intact', () => {
    expect(panelGeometryStyle({})).toEqual({})
    expect(panelGeometryStyle({ x: 8, y: 8 }).height).toBe('calc(100% - var(--dsc-panel-top, 9%) - var(--dsc-panel-bottom, 2%))')
    expect(panelGeometryStyle({ x: 8, y: 8, width: 420, height: 500 })).toMatchObject({ width: '420px', height: '500px' })
  })
  it('marks only visible custom owners, not generic styles or trigger descendants', () => {
    const source = (file: string) => readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    expect(source('panel.tsx')).toMatch(/className: `dsc-panel[^\n]*'data-window-drag-exclude': ''/)
    expect(source('panel.tsx').match(/className: 'dsc-picker-overlay', 'data-window-drag-exclude': ''/g)).toHaveLength(4)
    expect(source('lightbox.tsx')).toContain("className: 'dsc-lightbox', 'data-window-drag-exclude': ''")
    expect(source('connection.tsx')).toMatch(/className: `dsc-conn-toast[^\n]*'data-window-drag-exclude': ''/)
    expect(source('trigger.tsx')).not.toContain('data-window-drag-exclude')
    expect(source('styles.ts')).not.toContain('data-window-drag-exclude')
  })
})
