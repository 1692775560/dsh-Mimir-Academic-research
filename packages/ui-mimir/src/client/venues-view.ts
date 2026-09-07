/**
 * The venues view's pure presentation fold: conference-card filtering
 * (text/rank/field/window), the watched-first ordering, countdown formatting,
 * and the CCF-A journal directory's own text/field filter. DOM-free so the
 * fold is unit-testable; the wire types come from the host's
 * `listVenueDeadlines` result.
 * @module dsh-client-ui-mimir/client/venues-view
 */

import type { VenueDeadlineView, VenueJournalView } from 'dsh-mimir/types'

/** The conferences/journals toggle of the venues view. */
export type VenueMode = 'conferences' | 'journals'

/** One active filter set of the conference list. */
export interface VenueFilter {
  /** Free text matched case-insensitively against title, full name, dblp key. */
  readonly query: string
  /** Keep only one CCF rank; null passes every rank. */
  readonly rank: 'A' | 'B' | 'C' | null
  /** Keep only one ccfddl field code (exact, case-insensitive); null passes all. */
  readonly sub: string | null
  /** Keep only editions whose next deadline lands within this many days; null passes all. */
  readonly withinDays: number | null
}

/** The blank filter (everything passes). */
export const EMPTY_VENUE_FILTER: VenueFilter = Object.freeze({ query: '', rank: null, sub: null, withinDays: null })

/**
 * Calendar days from `nowMs` to one ISO instant, in the host's local zone,
 * so a deadline later today is 0 — the same rule the host's `daysUntil`
 * applies to `withinDays`, so the card countdown and the server filter never
 * disagree. (`Math.ceil` on the raw gap said "1 day left" for a deadline
 * five minutes away.)
 */
export function venueDaysLeft(iso: string, nowMs: number): number {
  const startOfLocalDay = (ms: number): number => {
    const date = new Date(ms)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  }
  return Math.round((startOfLocalDay(new Date(iso).getTime()) - startOfLocalDay(nowMs)) / 86_400_000)
}

/**
 * Countdown urgency of one deadline: `soon` inside 30 days (the highlighted
 * card state), `past`/null for everything else.
 */
export function venueCountdownState(daysLeft: number): 'soon' | null {
  return daysLeft >= 0 && daysLeft < 30 ? 'soon' : null
}

/**
 * Filter and order the conference list. The ordering is watched-first, then
 * next-deadline ascending, deadline-less (fully past) editions last, ties by
 * title — the answer to "what closes next that I care about".
 * @param venues - the catalog as the host served it.
 * @param watched - series keys the selected project watches.
 * @param filter - the active narrowing fields.
 * @param nowMs - the reference instant (injectable for tests).
 * @returns the visible cards in display order.
 */
export function filterVenues(
  venues: readonly VenueDeadlineView[],
  watched: readonly string[],
  filter: VenueFilter,
  nowMs: number,
): VenueDeadlineView[] {
  const needle = filter.query.trim().toLowerCase()
  const sub = filter.sub?.toLowerCase() ?? ''
  const out = venues.filter((venue) => {
    if (filter.rank !== null && venue.ccfRank !== filter.rank) return false
    if (sub !== '' && venue.sub.toLowerCase() !== sub) return false
    if (needle !== ''
      && !venue.title.toLowerCase().includes(needle)
      && !venue.description.toLowerCase().includes(needle)
      && !(venue.dblp ?? '').toLowerCase().includes(needle)) return false
    if (filter.withinDays !== null) {
      if (venue.nextDeadlineAt === null) return false
      if (venueDaysLeft(venue.nextDeadlineAt, nowMs) > filter.withinDays) return false
    }
    return true
  })
  const watchedSet = new Set(watched)
  return out.sort((a, b) => {
    const aw = watchedSet.has(a.key) ? 0 : 1
    const bw = watchedSet.has(b.key) ? 0 : 1
    if (aw !== bw) return aw - bw
    if (a.nextDeadlineAt === null) return b.nextDeadlineAt === null ? a.title.localeCompare(b.title) : 1
    if (b.nextDeadlineAt === null) return -1
    return new Date(a.nextDeadlineAt).getTime() - new Date(b.nextDeadlineAt).getTime()
  })
}

/** The distinct field codes present in the served catalog, sorted (the filter dropdown). */
export function venueFilterSubs(venues: readonly VenueDeadlineView[]): string[] {
  return [...new Set(venues.map(venue => venue.sub).filter(sub => sub !== ''))].sort()
}

/**
 * Count the catalog's deadlines landing inside `withinDays` days — the
 * overview's "upcoming DDL" stat chip.
 */
export function countUpcomingDeadlines(venues: readonly VenueDeadlineView[], withinDays: number, nowMs: number): number {
  return venues.filter(venue =>
    venue.nextDeadlineAt !== null && venueDaysLeft(venue.nextDeadlineAt, nowMs) <= withinDays,
  ).length
}

/**
 * Filter the static journal directory by free text (title and full name)
 * and/or one field label; a null selector passes everything on its axis.
 */
export function filterJournals(
  journals: readonly VenueJournalView[],
  query: string,
  sub: string | null,
): VenueJournalView[] {
  const needle = query.trim().toLowerCase()
  return journals.filter(journal =>
    (sub === null || journal.sub === sub)
    && (needle === ''
      || journal.title.toLowerCase().includes(needle)
      || journal.fullName.toLowerCase().includes(needle)))
}

/** The distinct field labels of the journal directory, in first-appearance order. */
export function journalSubs(journals: readonly VenueJournalView[]): string[] {
  return [...new Set(journals.map(journal => journal.sub))]
}
