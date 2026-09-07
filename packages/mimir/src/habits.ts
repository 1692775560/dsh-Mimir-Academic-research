/**
 * CBE habit profile (S6): the researcher's own working rhythm, read off the
 * ledger's timestamps — when the day's work happens, how long a sitting
 * lasts, which weekdays carry the load, and how many days in a row the
 * ledger has been touched. This is the "科研习惯" organ, and it is the one
 * place the ledger describes the RESEARCHER rather than the research.
 *
 * Everything here is E0 arithmetic over timestamps: sessions cut at the
 * map's own {@link CBE_SESSION_GAP_MINUTES} gap, counts per hour and per
 * weekday, and a consecutive-day run. Deliberate boundaries, registered
 * rather than hidden:
 *
 *  1. **No advice, ever.** The profile says "you work in the late evening";
 *     it never says "you should work in the morning". Rhythm is a
 *     description of attention already spent, not a prescription for
 *     attention not yet spent — the origin rule forbids telling a
 *     researcher when to sit down.
 *  2. **A session is a gap, not a task.** Two events 20 minutes apart are
 *     one sitting; the ledger cannot see what happened in between, and
 *     does not guess.
 *  3. **Clock hours are LOCAL** (the researcher's wall clock, not UTC) —
 *     "late evening" must mean the evening they lived, so the derivation
 *     reads the host's timezone. Tests pin this by injecting timestamps.
 *  4. **Silence below the floor** (I2's rule): under
 *     {@link CBE_HABIT_MIN_SESSIONS} sessions the comparative numbers stay
 *     null while the bare counts still render.
 * @module dsh-mimir/src/habits
 */

import { CBE_SESSION_GAP_MINUTES } from './vocabulary.ts'
import type { EventRecord } from './types.ts'
import { MS_PER_DAY, MS_PER_MINUTE, sessionize, sliceEvents, tsToMs } from './time.ts'

/** Sessions before the comparative numbers may speak (I2's floor). */
export const CBE_HABIT_MIN_SESSIONS = 3

/** Events before any session arithmetic is attempted at all. */
export const CBE_HABIT_MIN_EVENTS = 5

/** Round to 3 decimals for stable rendering/serialization. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** One sitting: consecutive events with no gap wider than the session gap. */
export interface CbeSession {
  readonly startedAt: string
  readonly endedAt: string
  /** Wall-clock minutes from the first event to the last (0 for a lone event). */
  readonly minutes: number
  readonly eventCount: number
}

/** One hour-of-day bucket (0–23, the researcher's local clock). */
export interface CbeHourBucket {
  readonly hour: number
  readonly count: number
}

/** One weekday bucket (0 = Sunday, the researcher's local calendar). */
export interface CbeWeekdayBucket {
  readonly weekday: number
  readonly count: number
}

/** The whole derived habit profile (L1: re-derivable, never persisted). */
export interface CbeHabitProfile {
  readonly asOf: string
  readonly eventCount: number
  readonly sessions: readonly CbeSession[]
  readonly sessionCount: number
  /** Median sitting length in minutes; null while the profile stays silent. */
  readonly medianSessionMinutes: number | null
  readonly longestSessionMinutes: number | null
  /** Busiest hours first (only hours that carry at least one event). */
  readonly activeHours: readonly CbeHourBucket[]
  /** Monday-first histogram, including zero-count weekdays. */
  readonly weekdayHistogram: readonly CbeWeekdayBucket[]
  /** Distinct local calendar days that carry at least one event. */
  readonly activeDays: number
  /** Consecutive local days with activity, counting back from `now`. */
  readonly currentStreakDays: number
  readonly speaks: boolean
}

/** Median of a numeric list (even length → mean of the two middle values). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * Cut an event stream into sittings: a new session starts whenever the gap to
 * the previous event exceeds {@link CBE_SESSION_GAP_MINUTES}.
 *
 * The cut is the shared {@link sessionize} primitive, projected onto the
 * `{startedAt, endedAt, minutes, eventCount}` rows this profile reports. The
 * input may be in any order — it is ordered internally, so a caller can never
 * hand an unsorted stream to the cut and silently get wrong sittings.
 * Unparseable timestamps are dropped (they cannot be placed on a clock).
 * @param events - ledger events, any order.
 * @returns the sessions in time order.
 */
export function deriveSessions(events: readonly EventRecord[]): readonly CbeSession[] {
  const sessions: CbeSession[] = []
  for (const group of sessionize(events, CBE_SESSION_GAP_MINUTES)) {
    const startMs = tsToMs(group[0]?.ts ?? '') ?? 0
    const lastMs = tsToMs(group[group.length - 1]?.ts ?? '') ?? startMs
    sessions.push(Object.freeze({
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(lastMs).toISOString(),
      minutes: r3((lastMs - startMs) / MS_PER_MINUTE),
      eventCount: group.length,
    }))
  }
  return Object.freeze(sessions)
}

/**
 * Derive the habit profile over one window. Hours and weekdays are read in
 * the host's LOCAL timezone ("late evening" must be the evening the
 * researcher lived); the streak counts back from `nowMs`, so a ledger last
 * touched yesterday shows a 0-day streak honestly rather than pretending
 * today happened.
 * @param events - ledger events, any order; filtered to [since, until).
 * @param since - window start, inclusive (ISO-8601).
 * @param until - window end, exclusive (ISO-8601).
 * @param nowMs - "now" in epoch ms (injectable for determinism).
 * @returns the derived habit profile.
 */
export function deriveHabits(
  events: readonly EventRecord[],
  since: string,
  until: string,
  nowMs: number,
): CbeHabitProfile {
  const untilMs = tsToMs(until) ?? nowMs
  const sinceMs = tsToMs(since) ?? 0
  // The shared slice: same window semantics as every other fold, and already
  // in canonical order, so no second sort is needed below.
  const inWindow = sliceEvents(events, sinceMs, untilMs)

  const sessions = deriveSessions(inWindow)
  const lengths = sessions.map(session => session.minutes)
  const speaks = sessions.length >= CBE_HABIT_MIN_SESSIONS
    && inWindow.length >= CBE_HABIT_MIN_EVENTS

  const hourCounts = new Map<number, number>()
  const weekdayCounts = new Map<number, number>()
  const days = new Set<string>()
  for (const event of inWindow) {
    const at = new Date(tsToMs(event.ts) ?? 0)
    const hour = at.getHours()
    const weekday = at.getDay()
    hourCounts.set(hour, (hourCounts.get(hour) ?? 0) + 1)
    weekdayCounts.set(weekday, (weekdayCounts.get(weekday) ?? 0) + 1)
    days.add(`${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`)
  }

  // Streak: consecutive local calendar days, counting back from now.
  let streak = 0
  for (let offset = 0; offset < 3650; offset += 1) {
    const day = new Date(nowMs - offset * MS_PER_DAY)
    const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`
    if (!days.has(key)) break
    streak += 1
  }

  const activeHours = [...hourCounts.entries()]
    .map(([hour, count]) => Object.freeze({ hour, count }))
    .sort((a, b) => b.count - a.count || a.hour - b.hour)
  // Monday-first: 1,2,3,4,5,6,0 — zero-count weekdays stay visible.
  const weekdayHistogram = [1, 2, 3, 4, 5, 6, 0]
    .map(weekday => Object.freeze({ weekday, count: weekdayCounts.get(weekday) ?? 0 }))

  return Object.freeze({
    asOf: new Date(nowMs).toISOString(),
    eventCount: inWindow.length,
    sessions: Object.freeze(sessions),
    sessionCount: sessions.length,
    medianSessionMinutes: speaks ? r3(median(lengths)) : null,
    longestSessionMinutes: speaks ? r3(Math.max(0, ...lengths)) : null,
    activeHours: Object.freeze(activeHours),
    weekdayHistogram: Object.freeze(weekdayHistogram),
    activeDays: days.size,
    currentStreakDays: streak,
    speaks,
  })
}
