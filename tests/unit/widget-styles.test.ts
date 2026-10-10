import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every custom property a stylesheet reads has to either be defined somewhere or carry a
 * fallback.
 *
 * This exists because of a specific bug: the border beam painted its gradient from
 * `var(--beam-color)`, which nothing ever defined. A `var()` with no fallback and no
 * definition is not ignored — it invalidates the entire declaration it appears in. The
 * element still got its layout, so the widget looked perfectly normal, but the beam was
 * simply not painted. Nothing failed, nothing warned, and the animation was invisible.
 */
const CSS_DIR = join(process.cwd(), 'src/renderer/widget')

function readStylesheets(): Map<string, string> {
  const files = readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'))
  return new Map(files.map((f) => [f, readFileSync(join(CSS_DIR, f), 'utf8')]))
}

/** `--name: value` declarations, which is what makes a property available to read. */
function definedProperties(sheets: Map<string, string>): Set<string> {
  const names = new Set<string>()
  for (const css of sheets.values()) {
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) names.add(m[1]!)
  }
  return names
}

/** `var(--name)` reads that carry no fallback value. */
function unguardedReads(sheets: Map<string, string>): Array<[string, string]> {
  const found: Array<[string, string]> = []
  for (const [file, css] of sheets) {
    // Strip comments so documented examples are not mistaken for real usage.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of code.matchAll(/var\((--[a-z0-9-]+)\s*\)/gi)) found.push([file, m[1]!])
  }
  return found
}

describe('widget stylesheets', () => {
  const sheets = readStylesheets()

  it('declares the beam colour', () => {
    // The bug itself: read but never defined, so the gradient never painted.
    expect(definedProperties(sheets)).toContain('--beam-color')
  })

  it('reads only custom properties that exist or have a fallback', () => {
    const defined = definedProperties(sheets)
    const missing = unguardedReads(sheets).filter(([, name]) => !defined.has(name))
    expect(
      missing.map(([file, name]) => `${file}: ${name}`),
      'these are read with no fallback and defined nowhere, so the declaration is dropped'
    ).toEqual([])
  })

  it('uses the border-radius the beam path depends on', () => {
    // The motion path is `rect(... round var(--radius))`; without it there is no contour
    // for the beam to follow.
    expect(definedProperties(sheets)).toContain('--radius')
  })
})