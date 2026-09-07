/**
 * Behavior tests for the venues view's pure fold: the watched-first ordering
 * with next-deadline ascending, the text/rank/field/window narrowing, the
 * countdown urgency, the overview's upcoming-deadline count, and the journal
 * directory's own filter.
 */

import { describe, expect, it } from 'vitest'
import type { VenueDeadlineView, VenueJournalView } from 'dsh-mimir/types'
import {
  countUpcomingDeadlines,
  EMPTY_VENUE_FILTER,
  filterJournals,
  filterVenues,
  journalSubs,
  venueCountdownState,
  venueDaysLeft,
  venueFilterSubs,
} from '../src/client/venues-view.ts'

/** 2026-09-01T00:00:00Z. */
const NOW = Date.UTC(2026, 8, 1)

/** One catalog row factory; only the identity and the next deadline vary. */
function venue(key: string, patch: Partial<VenueDeadlineView> = {}): VenueDeadlineView {
  return {
    key,
    title: key.toUpperCase(),
    description: `The ${key} conference`,
    sub: 'AI',
    ccfRank: 'A',
    dblp: null,
    conf: { year: 2027, id: `${key}27`, link: `https://${key}.example/`, date: 'June 1, 2027', place: 'Mars', timeline: [] },
    nextDeadlineAt: null,
    nextDeadlineKind: null,
    ...patch,
  }
}

/** ISO instant `days` after NOW. */
function inDays(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString()
}

describe('venueDaysLeft / venueCountdownState', () => {
  /** Local noon, so the calendar-day arithmetic is not zone-dependent. */
  const localNoon = (year: number, month: number, day: number, hour = 12): number =>
    new Date(year, month, day, hour).getTime()

  it('counts calendar days, matching the host daysUntil: a deadline later today is 0', () => {
    const now = localNoon(2026, 8, 1)
    // The case the old Math.ceil got wrong: a deadline one second or eleven
    // hours away is still today, and the card must not claim "1 day left".
    expect(venueDaysLeft(new Date(now + 1000).toISOString(), now)).toBe(0)
    expect(venueDaysLeft(new Date(now + 5 * 60_000).toISOString(), now)).toBe(0)
    expect(venueDaysLeft(new Date(localNoon(2026, 8, 1, 23)).toISOString(), now)).toBe(0)
  })

  it('counts tomorrow as 1 however few hours away it is; past is negative', () => {
    const now = localNoon(2026, 8, 1, 23)
    expect(venueDaysLeft(new Date(localNoon(2026, 8, 2, 0)).toISOString(), now)).toBe(1)
    expect(venueDaysLeft(inDays(10), NOW)).toBe(10)
    expect(venueDaysLeft(new Date(NOW - 86_400_000).toISOString(), NOW)).toBe(-1)
  })

  it('marks only the 0–29 day window as soon', () => {
    expect(venueCountdownState(0)).toBe('soon')
    expect(venueCountdownState(29)).toBe('soon')
    expect(venueCountdownState(30)).toBeNull()
    expect(venueCountdownState(-1)).toBeNull()
  })
})

describe('filterVenues', () => {
  const LIST = [
    venue('cvpr', { nextDeadlineAt: inDays(60), nextDeadlineKind: 'paper' }),
    venue('sosp', { sub: 'SE', nextDeadlineAt: inDays(10), nextDeadlineKind: 'abstract' }),
    venue('tbd-conf', { ccfRank: 'C', sub: 'NW' }),
    venue('icml', { nextDeadlineAt: inDays(40), nextDeadlineKind: 'paper' }),
  ]

  it('orders watched first, then next deadline ascending, deadline-less last', () => {
    const cards = filterVenues(LIST, ['icml'], EMPTY_VENUE_FILTER, NOW)
    expect(cards.map(card => card.key)).toEqual(['icml', 'sosp', 'cvpr', 'tbd-conf'])
  })

  it('narrows by free text, rank, field, and window', () => {
    expect(filterVenues(LIST, [], { ...EMPTY_VENUE_FILTER, query: 'sosp' }, NOW).map(card => card.key)).toEqual(['sosp'])
    expect(filterVenues(LIST, [], { ...EMPTY_VENUE_FILTER, rank: 'C' }, NOW).map(card => card.key)).toEqual(['tbd-conf'])
    expect(filterVenues(LIST, [], { ...EMPTY_VENUE_FILTER, sub: 'se' }, NOW).map(card => card.key)).toEqual(['sosp'])
    expect(filterVenues(LIST, [], { ...EMPTY_VENUE_FILTER, withinDays: 30 }, NOW).map(card => card.key)).toEqual(['sosp'])
    expect(filterVenues(LIST, [], { ...EMPTY_VENUE_FILTER, withinDays: 45 }, NOW).map(card => card.key)).toEqual(['sosp', 'icml'])
  })

  it('collects the field codes of the served catalog', () => {
    expect(venueFilterSubs(LIST)).toEqual(['AI', 'NW', 'SE'])
  })
})

describe('countUpcomingDeadlines', () => {
  it('counts only deadlines inside the window (the overview chip)', () => {
    const list = [
      venue('a', { nextDeadlineAt: inDays(5) }),
      venue('b', { nextDeadlineAt: inDays(30) }),
      venue('c', { nextDeadlineAt: inDays(31) }),
      venue('d'),
    ]
    expect(countUpcomingDeadlines(list, 30, NOW)).toBe(2)
  })
})

describe('journal directory fold', () => {
  const JOURNALS: VenueJournalView[] = [
    { title: 'TPAMI', fullName: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', sub: '人工智能', publisher: 'IEEE' },
    { title: 'TODS', fullName: 'ACM Transactions on Database Systems', sub: '数据库/数据挖掘/内容检索', publisher: 'ACM' },
  ]

  it('filters by text (title or full name) and field', () => {
    expect(filterJournals(JOURNALS, '', null).length).toBe(2)
    expect(filterJournals(JOURNALS, 'tpami', null).map(journal => journal.title)).toEqual(['TPAMI'])
    expect(filterJournals(JOURNALS, 'database', null).map(journal => journal.title)).toEqual(['TODS'])
    expect(filterJournals(JOURNALS, '', '人工智能').map(journal => journal.title)).toEqual(['TPAMI'])
    expect(filterJournals(JOURNALS, 'tpami', '计算机网络').length).toBe(0)
  })

  it('collects the field labels in first-appearance order', () => {
    expect(journalSubs(JOURNALS)).toEqual(['人工智能', '数据库/数据挖掘/内容检索'])
  })
})
