/**
 * #243: the rail is two tiers, and the second one is reachable rather than
 * hidden.
 *
 * The issue's failure mode is a first level that lists everything, so the main
 * path (pick a project, write the paper, keep the library, run the experiments)
 * competes with instruments you open once a week. The fix folds by capability
 * layer instead of by a hand-maintained list, so a view added to a core layer
 * lands on the main path on its own.
 *
 * What is asserted here: the partition is total and order-preserving, the fold
 * follows the layer rather than the tab identity, a single-tier rail still
 * renders, and the digits keep addressing the whole rail so a view behind More
 * is reachable by keyboard.
 */

import { describe, expect, it } from 'vitest'
import { railTiers, visibleTabs } from '../../ui-mimir/src/client/ResearchPanel.tsx'
import { tabForDigit } from '../../ui-mimir/src/client/shortcuts.ts'
import type { ResearchCapability } from 'dsh-mimir/types'

const ALL_ON = new Set<ResearchCapability>(['core', 'automation', 'compute', 'insights', 'presentation'])
const CORE_ONLY = new Set<ResearchCapability>(['core'])

describe('two-tier rail (#243)', () => {
  it('keeps the research main path on the first level', () => {
    const tiers = railTiers(ALL_ON)
    expect(tiers.primary).toEqual(['overview', 'paper', 'papers', 'experiments', 'figures', 'meetings'])
  })

  it('fold exactly the instrument layers', () => {
    const tiers = railTiers(ALL_ON)
    expect(tiers.secondary).toEqual(['venues', 'servers', 'ledger'])
  })

  it('partitions the rail without losing or reordering a tab', () => {
    const tiers = railTiers(ALL_ON)
    // Both tiers in rail order and, concatenated, exactly `visibleTabs`.
    const rail = visibleTabs(ALL_ON)
    expect([...tiers.primary, ...tiers.secondary].sort()).toEqual([...rail].sort())
    expect(tiers.primary).toEqual(rail.filter(tab => tiers.primary.includes(tab)))
    expect(tiers.secondary).toEqual(rail.filter(tab => tiers.secondary.includes(tab)))
  })

  it('folds by layer, not by tab identity', () => {
    // Figures and Meetings are presentation: still main path. The instrument
    // layers are what fold, which is why a new core view needs no edit here.
    const tiers = railTiers(new Set<ResearchCapability>(['core', 'presentation']))
    expect(tiers.secondary).toEqual([])
    expect(tiers.primary).toEqual(visibleTabs(new Set<ResearchCapability>(['core', 'presentation'])))
  })

  it('renders a single tier when nothing is folded', () => {
    expect(railTiers(CORE_ONLY)).toEqual({
      primary: ['overview', 'paper', 'papers', 'experiments'],
      secondary: [],
    })
  })

  it('renders the full rail before the capability set is known', () => {
    // An unanswered capability request must not fold anything away: the tiers
    // fall back to the complete rail, same as `visibleTabs(null)`.
    const tiers = railTiers(null)
    expect(tiers.primary).toEqual(['overview', 'paper', 'papers', 'experiments', 'figures', 'meetings'])
    expect(tiers.secondary).toEqual(['venues', 'servers', 'ledger'])
  })

  it('keeps every folded view reachable by its digit', () => {
    // The rail order is the shortcut order across both tiers, so More never
    // becomes a keyboard dead end.
    const rail = visibleTabs(ALL_ON)
    expect(tabForDigit('6', rail)).toBe('meetings')
    expect(tabForDigit('7', rail)).toBe('venues')
    expect(tabForDigit('9', rail)).toBe('ledger')
  })

  it('freezes both tiers so a render cannot mutate the rail', () => {
    const tiers = railTiers(ALL_ON)
    expect(Object.isFrozen(tiers.primary)).toBe(true)
    expect(Object.isFrozen(tiers.secondary)).toBe(true)
  })
})
