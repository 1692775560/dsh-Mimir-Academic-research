/**
 * CBE moment-candidate generators (S9b): the five deterministic sources that
 * read the researcher's stream and PROPOSE moments — never decide them.
 *
 * The division of labour follows the curated-moment index (S9): the system
 * proposes, the researcher promotes (`cbe.moment.pin`) or declines
 * (`cbe.moment.pin {pinned:false}`). Nothing here ranks, scores, or says
 * which candidate matters more beyond the fixed significance ladder inside
 * one sitting; the output order is time order — `(at, id)` — full stop.
 *
 * The five sources, all pure folds:
 *  - `burst` (migrated from the S9 index): a sitting classified by the
 *    vocabulary's own ladder (eureka > terminal > creation > plain work).
 *  - `return-after-dormancy`: per line, the first decision event after a
 *    gap of `CBE_MOMENT_RETURN_GAP_DAYS` quiet days — the road re-opened.
 *  - `cross-line-convergence`: one sitting where `CBE_MOMENT_CONVERGENCE_LINES`
 *    distinct lines each carry at least one decision event.
 *  - `long-sitting`: a sitting at least `CBE_MOMENT_LONG_SITTING_FACTOR` ×
 *    the median sitting length; the median stays silent (source skipped)
 *    until `CBE_MOMENT_LONG_SITTING_MIN_SESSIONS` sittings exist (I2: an
 *    unestimable baseline is not a zero baseline).
 *  - `milestone`: mainline moves, adoption/failure terminals (already
 *    terminal-class in `burst`, merged by anchor), and the first decision
 *    event of a line within the loaded stream (lane-opening; truncation
 *    honesty belongs to the caller's retrieval notes, not this fold).
 *
 * No EWS threshold selects anything here (the constitution's prediction
 * ban): `ews` and `closeness` ride along as DESCRIPTION only, and closeness
 * is null unless the eureka profile already speaks.
 *
 * Discipline: windowing/ordering/sessionization come only from `time.ts`;
 * classification only from `vocabulary.ts`; deterministic for a given input.
 * @module dsh-mimir/src/moment-candidates
 */

import {
  CREATION_ACTIONS,
  CBE_SESSION_GAP_MINUTES,
  TERMINAL_ACTIONS,
  isDecisionEvent,
  lineOf,
  signedWeight,
} from './vocabulary.ts'
import { EUREKA_ACTION, eurekaProfileOf, eurekaModelAt } from './eureka.ts'
import { windowFeatures } from './window-features.ts'
import type { CbeWindowFeatures } from './window-features.ts'
import { ewsReading } from './ledger-ews.ts'
import type { CbeEwsReading } from './ledger-ews.ts'
import { MS_PER_DAY, sessionize, sliceEvents, tsToMs } from './time.ts'
import type { EventRecord } from './types.ts'
import { MAINLINE_ACTION } from './worktree.ts'

/** Below this many events, a sitting with nothing significant is not a moment. */
export const CBE_MOMENT_BURST_MIN_EVENTS = 3

/** Quiet days on one line before a first event back counts as a return. */
export const CBE_MOMENT_RETURN_GAP_DAYS = 14

/** Distinct lines in one sitting before it counts as a convergence. */
export const CBE_MOMENT_CONVERGENCE_LINES = 2

/** A sitting this many × the median length counts as a long sitting. */
export const CBE_MOMENT_LONG_SITTING_FACTOR = 2

/** Sittings needed before the median may speak (I2 floor). */
export const CBE_MOMENT_LONG_SITTING_MIN_SESSIONS = 5

/** Where the structural sources' selection-power guard lives (see registry). */
export const CBE_MOMENT_CLOSNESS_ENABLED = true

/** The five deterministic proposal sources. */
export type CbeMomentSource =
  | 'burst'
  | 'return-after-dormancy'
  | 'cross-line-convergence'
  | 'long-sitting'
  | 'milestone'

/** The source order in a merged candidate's `sources` array (fixed). */
const SOURCE_ORDER: readonly CbeMomentSource[] = [
  'burst', 'return-after-dormancy', 'cross-line-convergence', 'long-sitting', 'milestone',
]

/** The structural stats of one candidate's backing sitting. */
export interface CbeMomentStats {
  readonly eventCount: number
  readonly creationCount: number
  /** r3; honest 0 on an empty fold (not a missing estimate). */
  readonly creationRatio: number
  /** r3. */
  readonly netSignedWeight: number
  readonly distinctLines: number
  /** count descending, then id ascending — deterministic. */
  readonly lineCounts: readonly { readonly lineId: string; readonly count: number }[]
  /** First→last event of the sitting, minutes, r1. */
  readonly spanMinutes: number
  readonly distinctDays: number
}

/** How many of the nine features sit closer to the lead-in vs control mean. */
export interface CbeClosenessVotes {
  readonly towardLead: number
  readonly towardControl: number
  readonly featureCount: number
}

/** One proposed moment: structural, descriptive, refusable. */
export interface CbeMomentCandidate {
  readonly anchorEventId: string
  readonly at: string
  readonly lineId: string | null
  readonly kind: 'eureka' | 'terminal' | 'creation' | 'burst'
    | 'return' | 'convergence' | 'long-sitting' | 'milestone'
  readonly sources: readonly CbeMomentSource[]
  readonly evidence: readonly string[]
  readonly stats: CbeMomentStats
  /** Window EWS reading; fields null below their own floor. */
  readonly ews: CbeEwsReading
  /** Null unless the eureka profile speaks AND comparable features exist. */
  readonly closeness: CbeClosenessVotes | null
}

/** Round to 3 decimals. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Round to 1 decimal. */
function r1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The significance ladder inside one sitting (the S9 rule, now the shared
 * ruler of the index and the sources): a declared Eureka outranks a
 * terminal, which outranks a creation, which outranks plain busy work at
 * or above the burst floor.
 */
export function kindOfBurst(
  burst: readonly EventRecord[],
): { readonly kind: CbeMomentCandidate['kind']; readonly action: string } | null {
  const eureka = burst.find(event => event.action === EUREKA_ACTION)
  if (eureka !== undefined) return { kind: 'eureka', action: eureka.action }
  const terminal = burst.find(event => TERMINAL_ACTIONS.has(event.action))
  if (terminal !== undefined) return { kind: 'terminal', action: terminal.action }
  const creation = burst.find(event => CREATION_ACTIONS.has(event.action))
  if (creation !== undefined) { return { kind: 'creation', action: creation.action } }
  if (burst.length >= CBE_MOMENT_BURST_MIN_EVENTS) {
    return { kind: 'burst', action: burst[0]?.action ?? '' }
  }
  return null
}

/**
 * The stats of one backing sitting: counts, creation share, line spread,
 * span, and active days. Reads only the sitting's own events.
 */
function statsOf(burst: readonly EventRecord[]): CbeMomentStats {
  const lineCounts = new Map<string, number>()
  const days = new Set<string>()
  let creationCount = 0
  let netSignedWeight = 0
  for (const event of burst) {
    const line = lineOf(event)
    if (line !== null) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1)
    const at = new Date(tsToMs(event.ts) ?? 0)
    days.add(`${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`)
    if (CREATION_ACTIONS.has(event.action)) creationCount += 1
    netSignedWeight += signedWeight(event)
  }
  const first = tsToMs(burst[0]?.ts ?? '')
  const last = tsToMs(burst[burst.length - 1]?.ts ?? '')
  const spanMinutes = first === null || last === null ? 0 : spanR1(first, last)
  const orderedCounts = [...lineCounts.entries()]
    .map(([lineId, count]) => ({ lineId, count }))
    .sort((a, b) => b.count - a.count || a.lineId.localeCompare(b.lineId))
  return Object.freeze({
    eventCount: burst.length,
    creationCount,
    creationRatio: burst.length === 0 ? 0 : r3(creationCount / burst.length),
    netSignedWeight: r3(netSignedWeight),
    distinctLines: lineCounts.size,
    lineCounts: Object.freeze(orderedCounts),
    spanMinutes,
    distinctDays: days.size,
  })
}

/** Round helper for span. */
function spanR1(first: number, last: number): number {
  return r1((last - first) / 60_000)
}

/**
 * Closeness votes: for each of the nine features carried by BOTH the window
 * and the profile rows, count which mean the window sits closer to. Null
 * unless the profile speaks — an unspoken profile is not a zero profile.
 */
function closenessOf(
  window: CbeWindowFeatures,
  profile: ReturnType<typeof eurekaProfileOf>,
): CbeClosenessVotes | null {
  // The one-switch retreat: closeness is DESCRIPTION power only; when the
  // guard is off the footnote disappears without touching the sources.
  if (!CBE_MOMENT_CLOSNESS_ENABLED) return null
  if (!profile.speaks) return null
  let towardLead = 0
  let towardControl = 0
  let featureCount = 0
  for (const row of profile.rows) {
    if (row.eurekaMean === null || row.controlMean === null) continue
    const value = window[row.feature]
    if (typeof value !== 'number') continue
    featureCount += 1
    if (Math.abs(value - row.eurekaMean) < Math.abs(value - row.controlMean)) towardLead += 1
    else towardControl += 1
  }
  if (featureCount === 0) return null
  return Object.freeze({ towardLead, towardControl, featureCount })
}

/**
 * Derive the moment candidates over one window: every source runs, same-
 * anchor candidates merge (sources union, ladder-kind wins), output is in
 * (at, id) time order. No ranking, no scoring, no prediction.
 * @param events - decision-grade ledger events (observations already
 * stripped by the caller), any order; may carry lookback prefix events
 * BEFORE sinceMs for line-history judgements — those never anchor.
 * @param sinceMs - window start, inclusive (epoch ms).
 * @param untilMs - window end, exclusive (epoch ms).
 * @returns the candidates in time order.
 */
export function deriveMomentCandidates(
  events: readonly EventRecord[],
  sinceMs: number,
  untilMs: number,
): readonly CbeMomentCandidate[] {
  const stream = sliceEvents(events, Number.NEGATIVE_INFINITY, untilMs)
  const windowed = sliceEvents(events, sinceMs, untilMs)
  const profile = eurekaProfileOf(eurekaModelAt(stream), Date.now())
  const sittings = sessionize(windowed, CBE_SESSION_GAP_MINUTES)
  const medianSittingMs = medianSittingSpan(sittings)

  const byAnchor = new Map<string, { candidate: CbeMomentCandidate; sources: Set<CbeMomentSource> }>()

  const propose = (
    anchor: EventRecord,
    burst: readonly EventRecord[],
    source: CbeMomentSource,
    kind: CbeMomentCandidate['kind'],
    lineId: string | null,
    evidence: readonly string[],
  ): void => {
    const window = sittingWindow(burst, untilMs)
    const features = windowFeatures(stream, lineId, window.fromMs, window.toMs)
    const ews = ewsReading(burst, window.fromMs, window.toMs)
    const entry = byAnchor.get(anchor.id)
    if (entry !== undefined) {
      entry.sources.add(source)
      // The ladder-kind of the merged candidate never downgrades.
      if (ladderRank(kind) > ladderRank(entry.candidate.kind)) {
        entry.candidate = { ...entry.candidate, kind }
      }
      return
    }
    byAnchor.set(anchor.id, {
      candidate: Object.freeze({
        anchorEventId: anchor.id,
        at: anchor.ts,
        lineId,
        kind,
        sources: [source],
        evidence: Object.freeze(evidence),
        stats: statsOf(burst),
        ews,
        closeness: closenessOf(features, profile),
      }),
      sources: new Set([source]),
    })
  }

  // ── Source 1: burst (the S9 ladder, migrated) ─────────────────────────
  for (const burst of sittings) {
    const classified = kindOfBurst(burst)
    if (classified === null) continue
    const anchor = burst.find(event => event.action === classified.action) ?? burst[0]
    if (anchor === undefined) continue
    if (tsToMs(anchor.ts) === null || (tsToMs(anchor.ts) ?? 0) < sinceMs) continue
    propose(anchor, burst, 'burst', classified.kind, lineOf(anchor), burst.map(event => event.id))
  }

  // ── Source 2: return-after-dormancy (per line) ────────────────────────
  // A return anchors the sitting's most significant event; when the burst
  // source already proposed that anchor, the sources simply union.
  for (const returned of returnsAfterDormancy(stream, sinceMs, untilMs)) {
    const sitting = sittingOf(sittings, returned)
    if (sitting === undefined) continue
    const anchor = mostSignificantOf(sitting) ?? returned
    propose(anchor, sitting, 'return-after-dormancy', 'return', lineOf(returned), sitting.map(event => event.id))
  }

  // ── Source 3: cross-line convergence ──────────────────────────────────
  for (const burst of sittings) {
    const decisionLines = new Set<string>()
    for (const event of burst) {
      if (!isDecisionEvent(event)) continue
      const line = lineOf(event)
      if (line !== null) decisionLines.add(line)
    }
    if (decisionLines.size < CBE_MOMENT_CONVERGENCE_LINES) continue
    const anchor = mostSignificantOf(burst) ?? burst[0]
    if (anchor === undefined) continue
    propose(anchor, burst, 'cross-line-convergence', 'convergence', null, burst.map(event => event.id))
  }

  // ── Source 4: long-sitting (median-gated) ─────────────────────────────
  if (medianSittingMs !== null) {
    for (const burst of sittings) {
      const first = tsToMs(burst[0]?.ts ?? '')
      const last = tsToMs(burst[burst.length - 1]?.ts ?? '')
      if (first === null || last === null) continue
      if (last - first <= medianSittingMs * CBE_MOMENT_LONG_SITTING_FACTOR) continue
      const anchor = burst[burst.length - 1] ?? burst[0]
      if (anchor === undefined) continue
      propose(anchor, burst, 'long-sitting', 'long-sitting', lineOf(anchor), burst.map(event => event.id)
      )
    }
  }

  // ── Source 5: milestone ───────────────────────────────────────────────
  const seenLines = new Set<string>()
  for (const event of sliceEvents(stream, Number.NEGATIVE_INFINITY, untilMs)) {
    const line = lineOf(event)
    if (line !== null && isDecisionEvent(event) && !seenLines.has(line)) {
      seenLines.add(line)
      if (inWindow(event, sinceMs, untilMs)) {
        const sitting = sittingOf(sittings, event)
        if (sitting !== undefined) {
          propose(event, sitting, 'milestone', 'milestone', line, [event.id])
        }
      }
    }
    if (event.action === MAINLINE_ACTION && inWindow(event, sinceMs, untilMs)) {
      const sitting = sittingOf(sittings, event)
      if (sitting !== undefined) {
        propose(event, sitting, 'milestone', 'milestone', lineOf(event), [event.id])
      }
    }
  }

  return Object.freeze(
    [...byAnchor.values()]
      .map(entry => (entry.sources.size <= 1
        ? entry.candidate
        : { ...entry.candidate, sources: SOURCE_ORDER.filter(source => entry.sources.has(source)) }))
      .sort((a, b) => a.at.localeCompare(b.at) || a.anchorEventId.localeCompare(b.anchorEventId)),
  )
}

/** Significance ladder rank (higher wins on merge). */
function ladderRank(kind: CbeMomentCandidate['kind']): number {
  const order = ['burst', 'long-sitting', 'convergence', 'return', 'milestone', 'creation', 'terminal', 'eureka'] as const
  return order.indexOf(kind)
}

/** The [fromMs, toMs) window a sitting's own events span, clamped to the fold window. */
function sittingWindow(burst: readonly EventRecord[], untilMs: number): { fromMs: number; toMs: number } {
  const first = tsToMs(burst[0]?.ts ?? '') ?? untilMs
  const last = tsToMs(burst[burst.length - 1]?.ts ?? '') ?? untilMs
  return { fromMs: first, toMs: last + 1 }
}

/** Median sitting span in ms; null below the I2 session floor or when the median carries no span to compare against. */
function medianSittingSpan(sittings: readonly (readonly EventRecord[])[]): number | null {
  if (sittings.length < CBE_MOMENT_LONG_SITTING_MIN_SESSIONS) return null
  const spans = sittings
    .map(burst => {
      const first = tsToMs(burst[0]?.ts ?? '')
      const last = tsToMs(burst[burst.length - 1]?.ts ?? '')
      return first === null || last === null ? null : last - first
    })
    .filter((span): span is number => span !== null)
    .sort((a, b) => a - b)
  if (spans.length === 0) return null
  const mid = Math.floor(spans.length / 2)
  const median = spans.length % 2 === 1 ? spans[mid]! : Math.round((spans[mid - 1]! + spans[mid]!) / 2)
  // A median of zero (mostly single-event sittings) is not a baseline the
  // factor can meaningfully scale — I2: unestimable, not zero.
  return median > 0 ? median : null
}

/** First decision events after `CBE_MOMENT_RETURN_GAP_DAYS` quiet days, per line. */
function returnsAfterDormancy(
  stream: readonly EventRecord[],
  sinceMs: number,
  untilMs: number,
): readonly EventRecord[] {
  const gapMs = CBE_MOMENT_RETURN_GAP_DAYS * MS_PER_DAY
  const out: EventRecord[] = []
  const lastSeen = new Map<string, number>()
  for (const event of stream) {
    if (!isDecisionEvent(event)) continue
    const line = lineOf(event)
    if (line === null) continue
    const at = tsToMs(event.ts)
    if (at === null) continue
    const previous = lastSeen.get(line)
    lastSeen.set(line, at)
    if (previous === undefined) continue
    if (at - previous >= gapMs && inWindow(event, sinceMs, untilMs)) {
      out.push(event)
    }
  }
  return out
}

/** The sitting (session chunk) containing one event, by id. */
function sittingOf(
  sittings: readonly (readonly EventRecord[])[],
  event: EventRecord,
): readonly EventRecord[] | undefined {
  for (const burst of sittings) {
    if (burst.some(candidate => candidate.id === event.id)) return burst
  }
  return undefined
}

/** The most significant event of a sitting by the shared ladder. */
function mostSignificantOf(burst: readonly EventRecord[]): EventRecord | undefined {
  const classified = kindOfBurst(burst)
  if (classified === null) return burst[0]
  return burst.find(event => event.action === classified.action) ?? burst[0]
}

/** Whether the event's parsed time falls in [sinceMs, untilMs). */
function inWindow(event: EventRecord, sinceMs: number, untilMs: number): boolean {
  const at = tsToMs(event.ts)
  return at !== null && at >= sinceMs && at < untilMs
}
