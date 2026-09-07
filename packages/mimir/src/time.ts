/**
 * Shared time primitives for every fold in the cognitive-beidou engine.
 *
 * This is the "锅底" (the broth) the hotpot metaphor calls for: every module
 * that reads the ledger — `eureka`, `ledger-ews`, `cbe-engine`, `cognitive-map`,
 * `foraging`, `habits`, `moment-index`, `report-tier`, … — used to re-declare
 * `tsToMs`, `MS_PER_DAY`, the `(ts, id)` ordered sort, the window slice, and
 * the session-gap cut by hand. That was a salad of duplicated definitions
 * where the sort key, the day constant, or the session gap could silently
 * drift between folds. They now live here, once, and every consumer imports
 * them.
 *
 * No business logic — only the unit conversions, the canonical ordering, the
 * window slice, and the session cut every derived quantity must share so two
 * folds never disagree on "what is in this window" or "what counts as one
 * sitting".
 *
 * This module is a LEAF: it imports nothing but the `EventRecord` type, so it
 * can never participate in a cycle. The policy constants that *parameterise*
 * these primitives (the session gap, the action vocabulary) live one layer up
 * in `./vocabulary.ts` and are passed in as arguments — never imported here.
 * @module dsh-mimir/src/time
 */

import type { EventRecord } from './types.ts'

/** Milliseconds in one day — the base unit of every sliding window here. */
export const MS_PER_DAY = 86_400_000

/** Milliseconds in one minute — the base unit of every session gap here. */
export const MS_PER_MINUTE = 60_000

/** Parse one ISO-8601 timestamp to epoch ms (NaN → null, never guessed). */
export function tsToMs(ts: string): number | null {
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Sort a copy into the canonical (ts, id) order every fold uses. Two events at
 * the same instant are ordered by id so the sequence is deterministic.
 * @param events - ledger events, any order.
 * @returns a new sorted array (the input is not mutated).
 */
export function orderedEvents(events: readonly EventRecord[]): EventRecord[] {
  return [...events].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
}

/**
 * The events that fall inside one half-open window [fromMs, toMs), in the
 * canonical (ts, id) order. Unparseable timestamps are dropped and cannot be
 * placed in any window. This is the single source of truth for "what counts as
 * inside the window" — every fold slices here, so no two folds can disagree.
 * @param events - ledger events, any order.
 * @param fromMs - window start, inclusive (epoch ms).
 * @param toMs - window end, exclusive (epoch ms).
 * @returns the matching events, ordered.
 */
export function sliceEvents(
  events: readonly EventRecord[],
  fromMs: number,
  toMs: number,
): EventRecord[] {
  return orderedEvents(events).filter(event => {
    const ms = tsToMs(event.ts)
    return ms !== null && ms >= fromMs && ms < toMs
  })
}

/**
 * Cut an event stream into sittings: consecutive events with no gap wider than
 * `gapMinutes` belong to the same group. Unparseable timestamps are dropped
 * (they cannot be placed on a clock, so they belong to no sitting).
 *
 * This is the single sessionization rule. Three modules used to re-derive it
 * with three different output shapes — `cognitive-map` wanted an
 * event-id → index map, `habits` wanted `{startedAt, endedAt, minutes}` rows,
 * and `moment-index` wanted the raw groups — which is how the cut silently
 * drifted (one of them even inlined the minute constant). The primitive now
 * returns the GROUPS, the only shape the other two cannot lose information
 * by deriving, and each caller projects onto what it needs.
 *
 * The input may be in any order: it is ordered internally, so a caller can
 * never hand an unsorted stream to a function that assumes ascending order.
 * @param events - ledger events, any order.
 * @param gapMinutes - inactivity that splits one sitting from the next.
 * @returns the sittings in time order, each non-empty, in (ts, id) order.
 */
export function sessionize(events: readonly EventRecord[], gapMinutes: number): EventRecord[][] {
  const gapMs = gapMinutes * MS_PER_MINUTE
  const groups: EventRecord[][] = []
  let current: EventRecord[] = []
  let previousMs: number | null = null
  for (const event of orderedEvents(events)) {
    const ms = tsToMs(event.ts)
    if (ms === null) continue
    if (previousMs !== null && ms - previousMs > gapMs) {
      if (current.length > 0) groups.push(current)
      current = []
    }
    current.push(event)
    previousMs = ms
  }
  if (current.length > 0) groups.push(current)
  return groups
}
