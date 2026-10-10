import type { CSSProperties } from 'react'

export interface BorderBeamProps {
  /** Seconds for one lap of the border. */
  duration?: number
  /**
   * Seconds to start the lap at. Negative by default so the beam is already part-way
   * round when it appears, instead of snapping to a corner on the first frame.
   */
  delay?: number
  /** Diameter of the travelling highlight, in pixels. */
  size?: number
}

/**
 * A highlight that travels once around the container's border.
 *
 * Drop it inside any positioned element: it fills that element, follows whatever radius
 * and size it has, and disables pointer events so it can never intercept a click meant
 * for the controls underneath.
 *
 * ```tsx
 * <div className="pill">
 *   <BorderBeam />
 *   …
 * </div>
 * ```
 */
export function BorderBeam({
  duration = 4,
  delay = 2,
  size = 130
}: BorderBeamProps): React.JSX.Element {
  const style = {
    '--beam-duration': `${duration}s`,
    // Negated so a positive `delay` advances the beam rather than postponing it.
    '--beam-delay': `-${delay}s`,
    '--beam-size': `${size}px`
  } as CSSProperties

  return (
    <>
      {/* Wider ring, blurred: the glow that makes the beam look like light. */}
      <span className="border-beam border-beam--halo" aria-hidden="true">
        <span className="border-beam__blob border-beam__blob--halo" style={style} />
      </span>
      {/* Thin ring: the beam itself, sharp and white. */}
      <span className="border-beam" aria-hidden="true">
        <span className="border-beam__blob" style={style} />
      </span>
    </>
  )
}