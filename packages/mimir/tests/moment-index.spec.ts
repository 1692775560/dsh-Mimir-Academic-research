/**
 * Feasibility proof for the curated-moment index (S9): the half-wiki over the
 * raw stream. Checks that the index PROPOSES from the stream but never
 * decides — a pin is what promotes, an unpin is a declaration rather than a
 * deletion, and a lonely event the heuristics ignored can still be promoted
 * by the person who was there.
 * @module dsh-mimir/tests/moment-index
 */

import { describe, expect, it } from 'vitest'
import {
  deriveCuratedMoments,
  momentPins,
  MOMENT_PIN_ACTION,
  CBE_MOMENT_BURST_MIN_EVENTS,
} from '../src/moment-index.ts'
import { EUREKA_ACTION } from '../src/eureka.ts'
import type { EventRecord, LedgerActor, LedgerJsonValue } from '../src/types.ts'

const USER: LedgerActor = { kind: 'user', id: 'panel' }

let seq = 0
function ev(
  ts: string,
  action = 'knowledge.idea.added',
  refs: Partial<EventRecord['refs']> = {},
  payload: Record<string, LedgerJsonValue> = {},
): EventRecord {
  seq += 1
  return Object.freeze({
    id: `ev-${String(seq).padStart(3, '0')}`,
    ts,
    actor: USER,
    action,
    refs: Object.freeze(refs),
    payload: Object.freeze(payload),
  })
}

const MIN = 60_000
const BASE = Date.parse('2026-08-20T09:00:00.000Z')
const at = (offsetMinutes: number): string => new Date(BASE + offsetMinutes * MIN).toISOString()

function pin(targetEventId: string, note = '', pinned = true): EventRecord {
  return ev(at(999), MOMENT_PIN_ACTION, {}, {
    targetEventId,
    ...(note === '' ? {} : { note }),
    ...(pinned ? {} : { pinned: false }),
  })
}

describe('pin declarations', () => {
  it('lets the last declaration win, so an unpin really overrides a pin', () => {
    const pins = momentPins([pin('a', 'good'), pin('a', '', false)])
    expect(pins.get('a')?.pinned).toBe(false)
  })

  it('keeps the note and defaults a missing flag to pinned', () => {
    const pins = momentPins([pin('b', '这是转折')])
    expect(pins.get('b')).toMatchObject({ note: '这是转折', pinned: true })
  })

  it('ignores a declaration with no target', () => {
    expect(momentPins([ev(at(1), MOMENT_PIN_ACTION, {}, {})]).size).toBe(0)
  })
})

describe('auto-candidates from the stream', () => {
  it('proposes a burst that carries a creation event', () => {
    const moments = deriveCuratedMoments([
      ev(at(0), 'knowledge.idea.added', { ideaId: 'i1' }),
      ev(at(5), 'experiments.saved', { ideaId: 'i1' }),
    ], null, null)
    expect(moments).toHaveLength(1)
    expect(moments[0]?.kind).toBe('creation')
    expect(moments[0]?.eventCount).toBe(2)
    expect(moments[0]?.pinned).toBe(false)
  })

  it('does not propose a quiet couple of events — that is just Tuesday', () => {
    // No line refs: S9b's milestone source keys off a line's first decision,
    // so unattributed events stay silent below the burst floor.
    const moments = deriveCuratedMoments([
      ev(at(0), 'writing.bib.saved'),
      ev(at(5), 'writing.bib.saved'),
    ], null, null)
    expect(moments).toEqual([])
  })

  it('proposes a plain burst once it reaches the floor', () => {
    const events = Array.from({ length: CBE_MOMENT_BURST_MIN_EVENTS }, (_, index) =>
      ev(at(index * 5), 'writing.bib.saved', { ideaId: 'i1' }))
    const moments = deriveCuratedMoments(events, null, null)
    expect(moments).toHaveLength(1)
    // S9b: the same anchor is also the line's first decision, so the burst
    // merges with the lane-opening milestone — the ladder keeps milestone.
    expect(moments[0]?.kind).toBe('milestone')
    expect(moments[0]?.sources).toContain('burst')
    expect(moments[0]?.sources).toContain('milestone')
  })

  it('lets a declared Eureka outrank a terminal in the same burst', () => {
    const moments = deriveCuratedMoments([
      ev(at(0), 'knowledge.idea.failed', { ideaId: 'i1' }),
      ev(at(5), EUREKA_ACTION, { ideaId: 'i1' }, { title: '想通了' }),
    ], null, null)
    // S9b also proposes a lane-opening milestone on the terminal itself, so
    // the Eureka is no longer first in time order — it still outranks the
    // terminal as the burst's kind.
    expect(moments.find(moment => moment.kind === 'eureka')).toBeDefined()
  })

  it('splits bursts at the session gap', () => {
    const moments = deriveCuratedMoments([
      ev(at(0), 'knowledge.idea.added', { ideaId: 'i1' }),
      ev(at(90), 'knowledge.idea.added', { ideaId: 'i2' }),
    ], null, null)
    expect(moments).toHaveLength(2)
  })
})

describe('the researcher promotes', () => {
  it('promotes a lonely event the heuristics ignored', () => {
    const lonely = ev(at(0), 'writing.bib.saved', { ideaId: 'i1' })
    const moments = deriveCuratedMoments([lonely, pin(lonely.id, '这里改了方向')], null, null)
    expect(moments).toHaveLength(1)
    expect(moments[0]?.kind).toBe('pinned')
    expect(moments[0]?.note).toBe('这里改了方向')
    expect(moments[0]?.pinned).toBe(true)
  })

  it('enriches an existing burst rather than duplicating it', () => {
    const anchor = ev(at(0), 'knowledge.idea.added', { ideaId: 'i1' })
    const moments = deriveCuratedMoments([
      anchor,
      ev(at(5), 'experiments.saved', { ideaId: 'i1' }),
      pin(anchor.id, '那天的下午'),
    ], null, null)
    expect(moments).toHaveLength(1)
    expect(moments[0]?.pinned).toBe(true)
    expect(moments[0]?.note).toBe('那天的下午')
    expect(moments[0]?.eventCount).toBe(2)
  })

  it('treats an unpin as a demotion, not a deletion', () => {
    const anchor = ev(at(0), 'knowledge.idea.added', { ideaId: 'i1' })
    const moments = deriveCuratedMoments([
      anchor,
      pin(anchor.id, 'maybe'),
      pin(anchor.id, '', false),
    ], null, null)
    expect(moments).toHaveLength(1)
    expect(moments[0]?.pinned).toBe(false)
    // The moment itself survives: the stream is still what happened.
    expect(moments[0]?.kind).toBe('creation')
  })
})

describe('windowing', () => {
  it('honours the window bounds', () => {
    const moments = deriveCuratedMoments([
      ev(at(0), 'knowledge.idea.added', { ideaId: 'i1' }),
      ev(at(200), 'knowledge.idea.added', { ideaId: 'i2' }),
    ], at(-1), at(60))
    expect(moments).toHaveLength(1)
    expect(moments[0]?.lineId).toBe('i1')
  })

  it('orders the index by time', () => {
    const moments = deriveCuratedMoments([
      ev(at(200), 'knowledge.idea.added', { ideaId: 'i2' }),
      ev(at(0), 'knowledge.idea.added', { ideaId: 'i1' }),
      ev(at(400), 'knowledge.idea.added', { ideaId: 'i3' }),
    ], null, null)
    expect(moments.map(moment => moment.lineId)).toEqual(['i1', 'i2', 'i3'])
  })
})
