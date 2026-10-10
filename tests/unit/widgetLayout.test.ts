import { describe, expect, it } from 'vitest'
import { WIDGET_HEIGHT, pillGapFromBottom, widgetBounds } from '../../src/main/core/widgetLayout'
import { WIDGET_SHADOW_ROOM } from '../../src/shared/types'
import { DEFAULT_CONFIG } from '../../src/shared/schema'

/**
 * The widget's whole appeal is being unobtrusive: a small pill, a consistent gap from
 * the screen edge, dead centre. These are the numbers that decide whether it is, so
 * they are asserted directly rather than eyeballed.
 */
const WORK_AREA = { x: 0, y: 31, width: 1596, height: 867 }
const BOTTOM = WORK_AREA.y + WORK_AREA.height

const PILL_HEIGHT = 44

/**
 * Where the pill's top edge sits inside the window: the stage pads the bottom by the
 * shadow room and bottom-anchors the pill, so everything left above is unused.
 */
function pillTopWithinWindow(windowHeight: number): number {
  return windowHeight - WIDGET_SHADOW_ROOM - PILL_HEIGHT
}

/**
 * The margin a user actually sees, derived the way the renderer lays it out.
 *
 * Note this assumes the window sits where it was asked to. That holds on X11, and on
 * Wayland it holds because the window spans the whole work area and the compositor can
 * only centre it.
 */
function measuredGap(window: { y: number; height: number }): number {
  return pillGapFromBottom(BOTTOM, window.y, pillTopWithinWindow(window.height), PILL_HEIGHT)
}

describe('widgetBounds', () => {
  it('centres horizontally', () => {
    const b = widgetBounds(WORK_AREA, 36, 460)
    const left = b.x - WORK_AREA.x
    const right = WORK_AREA.x + WORK_AREA.width - (b.x + b.width)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
  })

  it('stays centred when the work area is offset by a panel', () => {
    const area = { x: 0, y: 31, width: 1920, height: 1048 } // taskbar on the left
    const b = widgetBounds(area, 36, 460)
    expect(b.x).toBe(730) // (1920 - 460) / 2
  })

  it('stays a short strip rather than covering the work area', () => {
    // This window is permanently on top, so its height is the amount of the user's
    // screen it sits on. It only has to be as tall as the tallest state.
    const b = widgetBounds(WORK_AREA, 36, 460)
    expect(b.height).toBe(WIDGET_HEIGHT)
    expect(b.height).toBeLessThan(WORK_AREA.height / 2)
  })

  it('lands the pill exactly on the requested gap', () => {
    expect(measuredGap(widgetBounds(WORK_AREA, 36, 460))).toBe(36)
  })

  it('produces the same gap whatever the offset', () => {
    for (const gap of [8, 24, 36, 64, 120]) {
      expect(measuredGap(widgetBounds(WORK_AREA, gap, 460)), `offset ${gap}`).toBe(gap)
    }
  })

  it('keeps the pill on screen even at a zero gap', () => {
    const b = widgetBounds(WORK_AREA, 0, 460)
    expect(measuredGap(b)).toBe(0)
    expect(b.y + pillTopWithinWindow(b.height) + PILL_HEIGHT).toBeLessThanOrEqual(BOTTOM)
  })

  it('keeps the pill fully above the bottom even if the pill were taller', () => {
    // The review panel grows the pill upwards, not downwards, because the stage is
    // bottom-anchored — so a taller pill must not eat into the margin.
    for (const height of [44, 84, 140]) {
      const b = widgetBounds(WORK_AREA, 36, 460)
      // Each height is laid out from the same bottom anchor, so the gap cannot drift.
      const top = b.height - WIDGET_SHADOW_ROOM - height
      expect(pillGapFromBottom(BOTTOM, b.y, top, height)).toBe(36)
      expect(top).toBeGreaterThanOrEqual(0)
    }
  })

  it('tolerates a negative-ish work area without throwing', () => {
    expect(() => widgetBounds({ x: -10, y: 0, width: 800, height: 600 }, 36, 460)).not.toThrow()
  })

  it('defaults to a margin that clears the shadow', () => {
    // The window ends at the work area, so the pill's shadow has to fit inside the gap.
    expect(DEFAULT_CONFIG.ui.widgetOffsetBottom).toBeGreaterThanOrEqual(WIDGET_SHADOW_ROOM)
  })

  it('leaves room for the tallest state, not just the resting one', () => {
    // The review panel needs three lines of text plus buttons; if the window could be
    // shorter than that it would clip and force a resize mid-animation.
    expect(WIDGET_HEIGHT).toBeGreaterThan(140)
  })
})

describe('pillGapFromBottom', () => {
  it('is zero when the pill touches the bottom', () => {
    expect(pillGapFromBottom(1000, 900, 56, 44)).toBe(0)
  })

  it('counts the full pill height', () => {
    // 1000 - (900 + 56 + 44) = 0
    expect(pillGapFromBottom(1000, 900, 56, 44)).toBe(0)
    expect(pillGapFromBottom(1000, 890, 56, 44)).toBe(10)
  })
})