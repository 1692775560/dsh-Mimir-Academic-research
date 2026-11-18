/**
 * #242: capability layers, and the rail that honours them.
 *
 * The layer set is derived from switches that already exist, so the test pins
 * the derivation rather than a second list: `subscriptions.enabled` →
 * `automation`, `serverTools.enabled` → `compute`, `skills.enabled` →
 * `insights`, with `core` and `presentation` always on. The rail then renders
 * from that set, and the digits and arrow keys follow the rail.
 */

import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/index.ts'
import { arrowTab } from '../../ui-mimir/src/client/focus.ts'
import {
  shortcutFor,
  tabForDigit,
  type ShortcutInput,
} from '../../ui-mimir/src/client/shortcuts.ts'
import { visibleTabs } from '../../ui-mimir/src/client/ResearchPanel.tsx'
import type { ResearchCapability } from 'dsh-mimir/types'

/**
 * The capability set a given Config resolves to.
 *
 * The layer set deliberately does NOT live in the schema: it is derived in
 * `resolveConfig` from the switches the schema defaults, so reading it means
 * reading the derivation rather than `Config({})` — and that is the property
 * the issue asks for (one switch, not a second list to keep in sync).
 */
function capabilitiesFor(config: Record<string, unknown>): {
  enabled: readonly ResearchCapability[]
  disabled: readonly ResearchCapability[]
} {
  return resolveConfig(config as never).capabilities
}

const FULL_RAIL = ['overview', 'paper', 'papers', 'experiments', 'figures', 'meetings', 'venues', 'servers', 'ledger'] as const

describe('capability layering (#242)', () => {
  it('enables every layer by default', () => {
    const caps = capabilitiesFor({})
    expect(caps.enabled).toEqual(['core', 'automation', 'compute', 'insights', 'presentation'])
    expect(caps.disabled).toEqual([])
  })

  it('derives each layer from the switch that already existed', () => {
    expect(capabilitiesFor({ subscriptions: { enabled: false } }).enabled).not.toContain('automation')
    expect(capabilitiesFor({ serverTools: { enabled: false } }).enabled).not.toContain('compute')
    expect(capabilitiesFor({ skills: { enabled: false } }).enabled).not.toContain('insights')
    // The switches are independent: turning two off leaves the third alone.
    const onlyCompute = capabilitiesFor({ subscriptions: { enabled: false }, skills: { enabled: false } })
    expect(onlyCompute.enabled).toContain('compute')
    expect(onlyCompute.enabled).not.toContain('automation')
    expect(onlyCompute.enabled).not.toContain('insights')
  })

  it('keeps core and presentation unswitchable', () => {
    const off = capabilitiesFor({ subscriptions: { enabled: false }, serverTools: { enabled: false }, skills: { enabled: false } })
    expect(off.enabled).toContain('core')
    expect(off.enabled).toContain('presentation')
    // ...and lists what it turned off, so the panel can explain an absent tab.
    expect(capabilitiesFor({ skills: { enabled: false } }).disabled).toEqual(['insights'])
  })

  it('defaults every switch to on', () => {
    // The three switches the derivation reads default to on (the rest of the
    // defaults are #218's single source, not this issue's subject).
    const raw = Config({}) as { subscriptions: { enabled: boolean }; serverTools: { enabled: boolean }; skills: { enabled: boolean } }
    expect(raw.subscriptions.enabled).toBe(true)
    expect(raw.serverTools.enabled).toBe(true)
    expect(raw.skills.enabled).toBe(true)
  })

  it('renders the full rail while the capability set is unknown', () => {
    // A null set means "the answer has not arrived", not "nothing is enabled":
    // hiding a view on an unanswered request is worse than a late removal.
    expect(visibleTabs(null)).toEqual(FULL_RAIL)
  })

  it('removes a disabled layer\'s views from the rail entirely', () => {
    const rail = visibleTabs(new Set<ResearchCapability>(['core', 'presentation', 'automation']))
    expect(rail).toEqual(['overview', 'paper', 'papers', 'experiments', 'figures', 'meetings', 'venues'])
    expect(rail).not.toContain('servers')
    expect(rail).not.toContain('ledger')
  })

  it('collapses to the main path when every optional layer is off', () => {
    expect(visibleTabs(new Set<ResearchCapability>(['core']))).toEqual([
      'overview', 'paper', 'papers', 'experiments',
    ])
  })

  it('maps digits to the rail on screen, not the static list', () => {
    const rail = visibleTabs(new Set<ResearchCapability>(['core']))
    expect(tabForDigit('1', rail)).toBe('overview')
    expect(tabForDigit('4', rail)).toBe('experiments')
    // 5 would be Figures on the full rail; it is past the end here.
    expect(tabForDigit('5', rail)).toBeNull()
    // Without a rail the historical order stands.
    expect(tabForDigit('7')).toBe('servers')
  })

  it('steps arrows within the rail, never onto a hidden view', () => {
    const rail = visibleTabs(new Set<ResearchCapability>(['core']))
    expect(arrowTab('experiments', 'ArrowDown', rail)).toBe('overview')
    expect(arrowTab('overview', 'ArrowUp', rail)).toBe('experiments')
  })

  it('drives the shortcut mapping from the rail it is handed', () => {
    const rail = visibleTabs(new Set<ResearchCapability>(['core']))
    const base: Omit<ShortcutInput, 'key'> = { metaKey: false, ctrlKey: false, altKey: false, editable: false, fullscreen: false }
    expect(shortcutFor({ ...base, key: '4', rail })).toEqual({ type: 'tab', tab: 'experiments' })
    expect(shortcutFor({ ...base, key: '5', rail })).toBeNull()
    expect(shortcutFor({ ...base, key: '9' })).toEqual({ type: 'tab', tab: 'venues' })
  })
})
