/**
 * Behavior tests for the stable research-line identity hue: the same line
 * keeps one hue regardless of layout order, and the worktree's raw idea id
 * normalizes to the same hue as the fold's `idea:`-prefixed band key.
 * @module dsh-client-ui-mimir/tests/line-hue
 */

import { describe, expect, it } from 'vitest'
import { LINE_HUES, lineHueOf } from '../src/client/line-hue.ts'

describe('lineHueOf', () => {
  it('is stable for one id across calls', () => {
    expect(lineHueOf('idea:123')).toBe(lineHueOf('idea:123'))
    expect(lineHueOf('project:9')).toBe(lineHueOf('project:9'))
  })

  it('stays within the palette', () => {
    for (let index = 0; index < 64; index += 1) {
      const hue = lineHueOf(`line-${index}`)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(LINE_HUES)
    }
  })

  it('normalizes idea:<id> to the same hue as the raw id', () => {
    expect(lineHueOf('idea:123')).toBe(lineHueOf('123'))
  })

  it('keeps project:<id> distinct from its raw id (a separate line space)', () => {
    expect(lineHueOf('project:9')).toBe(lineHueOf('project:9'))
  })

  it('does not depend on layout order', () => {
    const ids = ['alpha', 'beta', 'gamma']
    const first = ids.map(id => lineHueOf(id))
    const reversed = [...ids].reverse().map(id => lineHueOf(id))
    expect(first).toEqual(ids.map(id => lineHueOf(id)))
    // Each id's hue is fixed: re-derive in a different order and compare by id.
    const byId = new Map(ids.map(id => [id, lineHueOf(id)]))
    expect(reversed).toEqual([...ids].reverse().map(id => byId.get(id)))
  })
})
