/**
 * #142 item 4: folding the sidebar rail used to hide `.headActions` wholesale,
 * which took the panel's close button with it. The theme and language toggles
 * are reachable from the host header; closing the panel is not. This pins the
 * rule: the two toggles hide, the close button does not.
 * @module dsh-client-ui-mimir/tests/folded-head-actions
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/client/ResearchPanel.module.css', import.meta.url)), 'utf8')

/** The `@media (min-width: 701px)` block that owns the folded rail. */
function foldedBlock(): string {
  const start = CSS.indexOf('@media (min-width: 701px)')
  expect(start).toBeGreaterThan(-1)
  const end = CSS.indexOf('\n}\n', CSS.indexOf('.side[data-folded] .sideFold', start))
  return CSS.slice(start, end)
}

describe('folded sidebar keeps the close button (#142 item 4)', () => {
  it('hides the theme and language toggles rather than the whole action group', () => {
    expect(foldedBlock()).toContain('.headActions > .iconButton')
    expect(foldedBlock()).not.toMatch(/\.side\[data-folded\]\s+\.headActions\s*,/)
  })

  it('keeps a rule that lays the remaining action out in the folded head', () => {
    expect(foldedBlock()).toContain('.side[data-folded] .headActions')
  })

  it('still hides the brand copy and the nav labels', () => {
    const block = foldedBlock()
    expect(block).toContain('.side[data-folded] .brandCopy')
    expect(block).toContain('.side[data-folded] .navLabel')
  })
})
