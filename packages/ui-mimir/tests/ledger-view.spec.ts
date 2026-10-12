/**
 * Behavior tests for the ledger view's pure logic: the window → filter and
 * report-options translation (ISO bounds, project scope, the all-time
 * special case), the archive-microtext timestamp parts (year omission,
 * invalid input), the payload summary line (priority keys, scalar fallback,
 * cap), and the report file name.
 */

import { describe, expect, it } from 'vitest'
import {
  ACTOR_KEYS,
  LEDGER_LIST_LIMIT,
  LEDGER_WINDOWS,
  ledgerIsDestructive,
  ledgerPayloadLine,
  ledgerTimeParts,
  ledgerWindowFilter,
  reportFileName,
  reportWindowOptions,
} from '../src/client/ledger-view.ts'
import { evidenceGraphRequestOf } from '../src/client/evidence-graph-view.ts'

/** A fixed wall clock: 2026-08-24T12:00:00Z. */
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0)

describe('ledgerWindowFilter', () => {
  it('bounds the recent windows (since inclusive, until exclusive = now)', () => {
    const filter = ledgerWindowFilter('7d', null, NOW)
    expect(filter.since).toBe(new Date(NOW - 7 * 86_400_000).toISOString())
    expect(filter.until).toBe(new Date(NOW).toISOString())
    expect(filter.projectId).toBeUndefined()
    expect(filter.order).toBe('desc')
    expect(filter.limit).toBe(LEDGER_LIST_LIMIT)
  })

  it('covers 30 and 90 day windows and omits bounds for all time', () => {
    expect(ledgerWindowFilter('30d', null, NOW).since).toBe(new Date(NOW - 30 * 86_400_000).toISOString())
    expect(ledgerWindowFilter('90d', null, NOW).since).toBe(new Date(NOW - 90 * 86_400_000).toISOString())
    const all = ledgerWindowFilter('all', null, NOW)
    expect(all.since).toBeUndefined()
    expect(all.until).toBe(new Date(NOW).toISOString())
  })

  it('carries the project scope when one is selected', () => {
    expect(ledgerWindowFilter('7d', 'p1', NOW).projectId).toBe('p1')
    expect(ledgerWindowFilter('all', 'p1', NOW).projectId).toBe('p1')
  })
})

describe('reportWindowOptions', () => {
  it('translates the window and scope without the list fields', () => {
    expect(reportWindowOptions('7d', 'p1', NOW)).toEqual({
      since: new Date(NOW - 7 * 86_400_000).toISOString(),
      projectId: 'p1',
    })
    expect(reportWindowOptions('all', null, NOW)).toEqual({})
  })
})

describe('ledgerTimeParts', () => {
  it('omits the year for the current year and keeps it for older events', () => {
    const sameYear = ledgerTimeParts('2026-08-01T09:05:00Z', NOW)
    expect(sameYear).not.toBeNull()
    expect(sameYear?.hasYear).toBe(false)
    expect(sameYear?.date).toMatch(/^-?\d{2}-\d{2}$/)
    expect(sameYear?.time).toHaveLength(5)

    const older = ledgerTimeParts('2025-06-15T12:00:00Z', NOW)
    expect(older?.hasYear).toBe(true)
    expect(older?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns null for an unparseable timestamp', () => {
    expect(ledgerTimeParts('not-a-date', NOW)).toBeNull()
  })
})

describe('ledgerPayloadLine', () => {
  it('prefers the priority keys and caps at three pairs', () => {
    const line = ledgerPayloadLine({
      payload: {
        name: 'run-a', status: 'succeeded', verdict: 'PASS', created: true,
        metricCount: 2, mode: 'replace', exitCode: 0,
      },
    })
    expect(line).toBe('name=run-a · status=succeeded · verdict=PASS')
  })

  it('skips arrays and nulls, and falls back to insertion order without priority keys', () => {
    expect(ledgerPayloadLine({ payload: { tags: ['a', 'b'], count: 3, name: 'x' } })).toBe('name=x')
    expect(ledgerPayloadLine({ payload: { alpha: 1, beta: 'two', gamma: null, delta: 4 } }))
      .toBe('alpha=1 · beta=two · delta=4')
    expect(ledgerPayloadLine({ payload: {} })).toBe('')
  })
})

describe('ledgerIsDestructive', () => {
  it('reads the destructive flag and ignores other truthy values', () => {
    expect(ledgerIsDestructive({ payload: { destructive: true } })).toBe(true)
    expect(ledgerIsDestructive({ payload: { destructive: 'yes' } })).toBe(false)
    expect(ledgerIsDestructive({ payload: {} })).toBe(false)
  })
})

describe('reportFileName', () => {
  it('dates the file from the report timestamp (local day of generatedAt)', () => {
    const stamp = new Date('2026-08-24T12:00:00Z')
    const pad = (value: number): string => String(value).padStart(2, '0')
    const expected = `mimir-progress-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}.md`
    expect(reportFileName('2026-08-24T12:00:00Z', NOW)).toBe(expected)
  })

  it('falls back to now for a missing or invalid timestamp', () => {
    expect(reportFileName(null, NOW)).toBe(`mimir-progress-${new Date(NOW).getFullYear()}-${String(new Date(NOW).getMonth() + 1).padStart(2, '0')}-${String(new Date(NOW).getDate()).padStart(2, '0')}.md`)
    expect(reportFileName('garbage', NOW)).toBe(reportFileName(null, NOW))
  })
})

describe('window and actor tables', () => {
  it('exposes the four windows in display order and all five actor labels', () => {
    expect(LEDGER_WINDOWS).toEqual(['7d', '30d', '90d', 'all'])
    expect(Object.keys(ACTOR_KEYS)).toEqual(['user', 'agent', 'subagent', 'module', 'system'])
    for (const key of Object.values(ACTOR_KEYS)) expect(key).toMatch(/^ledger\.actor\./)
  })
})

describe('evidenceGraphRequestOf', () => {
  it('bounds the recent windows with since = now − days and until = now', () => {
    expect(evidenceGraphRequestOf('7d', null, NOW)).toEqual({
      since: new Date(NOW - 7 * 86_400_000).toISOString(),
      until: new Date(NOW).toISOString(),
    })
    expect(evidenceGraphRequestOf('90d', null, NOW)).toEqual({
      since: new Date(NOW - 90 * 86_400_000).toISOString(),
      until: new Date(NOW).toISOString(),
    })
  })

  it('opens the lower bound for all time but keeps the until = now ceiling', () => {
    expect(evidenceGraphRequestOf('all', null, NOW)).toEqual({
      until: new Date(NOW).toISOString(),
    })
  })

  it('carries the project scope but never list-only fields', () => {
    const request = evidenceGraphRequestOf('30d', 'p1', NOW)
    expect(request.projectId).toBe('p1')
    expect('limit' in request).toBe(false)
    expect('order' in request).toBe(false)
  })
})
