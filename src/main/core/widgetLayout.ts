import { WIDGET_SHADOW_ROOM } from '@shared/types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Fallback window height, and the room the expanded pill and review panel need.
 * The window itself spans the work area; this is only a floor for platforms that
 * report no work area yet.
 */
export const WIDGET_HEIGHT = 168

/**
 * Position the widget window so the pill's lower edge sits exactly `offsetBottom`
 * above the bottom of the work area.
 *
 * The window is deliberately larger than the resting pill — it has to be, so the pill can
 * expand without a resize — but it stays a short strip pinned near the bottom edge.
 * That matters beyond tidiness: this window is permanently on top and covers a wide
 * horizontal band, so every extra pixel of height is a strip of the user's screen the
 * widget is sitting on top of.
 *
 * Sizing it to span the whole work area instead is tempting, because a Wayland
 * compositor will centre a window but will not honour a position request. That is not a
 * trade worth making: the app runs under XWayland, where the requested position *is*
 * honoured, so the window can simply be asked to go where it belongs.
 *
 * Its content is bottom-anchored, and the renderer reserves `WIDGET_SHADOW_ROOM` as
 * padding so the pill's drop shadow has somewhere to render instead of being clipped.
 *
 * Pure arithmetic, kept out of the Electron file so it can be tested directly.
 */
export function widgetBounds(
  workArea: { x: number; y: number; width: number; height: number },
  offsetBottom: number,
  width: number
): Rect {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(
      workArea.y + workArea.height - offsetBottom - WIDGET_HEIGHT + WIDGET_SHADOW_ROOM
    ),
    width,
    height: WIDGET_HEIGHT
  }
}

/**
 * The gap from the bottom of the work area to the bottom of the pill, given where the
 * pill ended up. Used by `--diagnose` to check the real rendered result rather than
 * trusting the arithmetic.
 */
export function pillGapFromBottom(
  workAreaHeightBottom: number,
  windowY: number,
  pillYWithinWindow: number,
  pillHeight: number
): number {
  return workAreaHeightBottom - (windowY + pillYWithinWindow + pillHeight)
}
