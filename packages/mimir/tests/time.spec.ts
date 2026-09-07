/**
 * Unit tests for the L0 time primitives (`time.ts`) — the "锅底" every fold
 * shares for ordering, window slicing, and sessionization. These three are
 * the single source of truth for "what is in this window" and "what counts as
 * one sitting"; if they drift, every derived quantity drifts with them, so
 * they get their own regression net.
 * @module dsh-mimir/tests/time.spec
 */

import { describe, expect, it } from 'vitest'
import { orderedEvents, sessionize, sliceEvents } from '../src/time.ts'
import type { EventRecord, LedgerActor, LedgerJsonValue } from '../src/types.ts'

const USER: LedgerActor = { kind: 'user', id: 'panel' }

let seq = 0
/** A fixture event with an auto-incrementing id (so ids sort by creation order). */
function ev(ts: string, action = 'x.y', refs: Partial<EventRecord['refs']> = {}): EventRecord {
  seq += 1
  return Object.freeze({
    id: `ev-${String(seq).padStart(4, '0')}`,
    ts,
    actor: USER,
    action,
    refs: Object.freeze(refs),
    payload: Object.freeze({} as Record<string, LedgerJsonValue>),
  })
}

/** A fixture event with an EXPLICIT id, for tiebreak tests. */
function raw(id: string, ts: string): EventRecord {
  return Object.freeze({
    id,
    ts,
    actor: USER,
    action: 'x.y',
    refs: Object.freeze({}),
    payload: Object.freeze({} as Record<string, LedgerJsonValue>),
  })
}

describe('orderedEvents', () => {
  it('returns a new sorted array and leaves the input untouched', () => {
    const input = [ev('2026-08-02T00:00:00Z'), ev('2026-08-01T00:00:00Z')]
    const out = orderedEvents(input)
    expect(out.map(e => e.ts)).toEqual(['2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'])
    // the original array order is preserved (no in-place mutation)
    expect(input[0].ts).toBe('2026-08-02T00:00:00Z')
  })

  it('breaks ts ties by id (deterministic regardless of input order)', () => {
    const input = [raw('ev-002', '2026-08-01T00:00:00Z'), raw('ev-001', '2026-08-01T00:00:00Z')]
    const out = orderedEvents(input)
    expect(out.map(e => e.id)).toEqual(['ev-001', 'ev-002'])
  })

  it('returns an empty array for empty input', () => {
    expect(orderedEvents([])).toEqual([])
  })

  it('does not throw on unparseable timestamps (they sort by their raw string)', () => {
    const input = [raw('ev-001', 'not-a-date'), raw('ev-002', '2026-08-01T00:00:00Z')]
    const out = orderedEvents(input)
    expect(out).toHaveLength(2)
  })
})

describe('sliceEvents', () => {
  const from = Date.parse('2026-08-01T00:00:00Z')
  const to = Date.parse('2026-08-02T00:00:00Z')

  it('is half-open [from, to): includes the start, excludes the end', () => {
    const input = [
      ev('2026-07-31T23:59:59Z'),
      ev('2026-08-01T00:00:00Z'),
      ev('2026-08-01T12:00:00Z'),
      ev('2026-08-02T00:00:00Z'),
    ]
    const out = sliceEvents(input, from, to)
    expect(out.map(e => e.ts)).toEqual(['2026-08-01T00:00:00Z', '2026-08-01T12:00:00Z'])
  })

  it('drops unparseable timestamps (they can be placed in no window)', () => {
    const input = [raw('ev-001', '2026-08-01T00:00:00Z'), raw('ev-002', 'garbage')]
    const out = sliceEvents(input, from, to)
    expect(out).toHaveLength(1)
  })

  it('returns empty when from > to', () => {
    expect(sliceEvents([ev('2026-08-01T00:00:00Z')], to, from)).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(sliceEvents([], from, to)).toEqual([])
  })
})

describe('sessionize', () => {
  it('a single event forms exactly one sitting', () => {
    const out = sessionize([ev('2026-08-01T00:00:00Z')], 30)
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveLength(1)
  })

  it('splits a sitting when the gap exceeds gapMinutes', () => {
    // 00:00 → 00:10 (10m, same sitting) → 01:00 (50m gap > 30m, new sitting)
    const input = [
      ev('2026-08-01T00:00:00Z'),
      ev('2026-08-01T00:10:00Z'),
      ev('2026-08-01T01:00:00Z'),
    ]
    const out = sessionize(input, 30)
    expect(out).toHaveLength(2)
    expect(out[0]).toHaveLength(2)
    expect(out[1]).toHaveLength(1)
  })

  it('keeps one sitting when every gap is within gapMinutes', () => {
    const input = [
      ev('2026-08-01T00:00:00Z'),
      ev('2026-08-01T00:05:00Z'),
      ev('2026-08-01T00:29:00Z'),
    ]
    const out = sessionize(input, 30)
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveLength(3)
  })

  it('drops unparseable timestamps (they belong to no sitting)', () => {
    const input = [
      raw('ev-001', '2026-08-01T00:00:00Z'),
      raw('ev-002', 'nope'),
      raw('ev-003', '2026-08-01T00:10:00Z'),
    ]
    const out = sessionize(input, 30)
    expect(out).toHaveLength(1)
    expect(out[0]).toHaveLength(2)
  })
})
