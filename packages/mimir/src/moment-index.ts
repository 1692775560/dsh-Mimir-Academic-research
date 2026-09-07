/**
 * CBE curated-moment index (S9): the half-wiki over the raw event stream.
 *
 * The ledger already keeps everything — `events` is append-only and nothing
 * is ever thrown away. But an append-only stream is a poor thing to browse:
 * the researcher cannot "look up" a breakthrough the way they look up a
 * paper. This module is the thin, RE-DERIVABLE index that makes the
 * trajectory navigable, and it deliberately sits at half-wiki depth:
 *
 *  - **It stores nothing.** Every curated moment is a fold over `events`.
 *    Delete the index and it rebuilds itself; it is L1, never a fact.
 *  - **Auto-candidates come from the stream** (a burst of work, a terminal
 *    outcome, a declared Eureka). The system proposes; it never decides.
 *  - **The researcher promotes.** A pin is one append-only declaration that
 *    says "this one mattered", and it can carry their own words. A pin is
 *    the only way a moment becomes canonical, which keeps the origin rule
 *    intact: significance belongs to the person who bore the uncertainty.
 *  - **Unpinning is a declaration too** (`pinned: false`), not a deletion —
 *    append-only means the change of mind is itself part of the record.
 *
 * Nothing here ranks moments, scores them, or suggests which to pin. The
 * index is a table of contents for a book only the researcher has read.
 * @module dsh-mimir/src/moment-index
 */

import { lineOf } from './vocabulary.ts'
import {
  CBE_MOMENT_BURST_MIN_EVENTS,
  deriveMomentCandidates,
} from './moment-candidates.ts'
import type { CbeMomentSource, CbeMomentStats, CbeClosenessVotes } from './moment-candidates.ts'
import type { CbeEwsReading } from './ledger-ews.ts'
import type { EventRecord } from './types.ts'
import { orderedEvents, sliceEvents, tsToMs } from './time.ts'

/** The researcher's pin (or unpin) of one moment, anchored to one event. */
export const MOMENT_PIN_ACTION = 'cbe.moment.pin'

export { CBE_MOMENT_BURST_MIN_EVENTS }

/** What kind of moment one index entry is. */
export type CbeMomentKind =
  | 'eureka' | 'terminal' | 'creation' | 'burst' | 'pinned'
  | 'return' | 'convergence' | 'long-sitting' | 'milestone'

/** One user pin declaration (last declaration per target wins). */
export interface CbeMomentPin {
  readonly targetEventId: string
  readonly note: string
  readonly pinned: boolean
}

/** One curated moment: the index's row. */
export interface CbeCuratedMoment {
  /** The anchoring event id (a pin on the same event reuses this id). */
  readonly id: string
  readonly at: string
  /** The line the moment belongs to, or null when unscoped. */
  readonly lineId: string | null
  readonly kind: CbeMomentKind
  /** Which deterministic sources proposed this moment (S9b; may be several). */
  readonly sources: readonly CbeMomentSource[]
  /** The anchor event's action name (labels resolve client-side). */
  readonly action: string
  /** The researcher's own words when they pinned it; null otherwise. */
  readonly note: string | null
  /** Events folded into this moment (its magnitude). */
  readonly eventCount: number
  readonly pinned: boolean
  /**
   * The researcher has SEEN and REFUSED this candidate: the last pin
   * declaration is `pinned:false` AND the moment was never canonical.
   * Distinct from unpin (was canonical, then demoted) — both live in the
   * stream and fold apart without new event types.
   */
  readonly declined: boolean
  /** The event ids backing the moment (the evidence). */
  readonly evidence: readonly string[]
  /** Structural stats of the backing sitting (S9b; always present). */
  readonly stats: CbeMomentStats
  /** The backing window's EWS reading; fields null below their own floor. */
  readonly ews: CbeEwsReading
  /** Descriptive closeness votes; null unless the eureka profile speaks. */
  readonly closeness: CbeClosenessVotes | null
}

/**
 * Which kind one burst of work is: a declared Eureka outranks a terminal,
 * which outranks a creation, which outranks a plain busy stretch. A burst
 * below {@link CBE_MOMENT_BURST_MIN_EVENTS} with nothing significant in it
 * is not a moment — it is just Tuesday. The ladder itself lives in
 * `moment-candidates.ts` (the S9b home of the generator sources); this
 * re-export is the index's read of it.
 */
export { kindOfBurst } from './moment-candidates.ts'


/**
 * Read the researcher's pin declarations: last declaration per target wins,
 * so an unpin really does override an earlier pin (append-only still — the
 * superseded declaration stays in the stream as history).
 * @param events - ledger events, any order.
 * @returns target event id → pin state.
 */
export function momentPins(events: readonly EventRecord[]): ReadonlyMap<string, CbeMomentPin> {
  const pins = new Map<string, CbeMomentPin>()
  const ordered = orderedEvents(events)
  for (const event of ordered) {
    if (event.action !== MOMENT_PIN_ACTION) continue
    const target = event.payload['targetEventId']
    if (typeof target !== 'string') continue
    const note = typeof event.payload['note'] === 'string' ? event.payload['note'] : ''
    const pinned = event.payload['pinned'] !== false
    pins.set(target, Object.freeze({ targetEventId: target, note, pinned }))
  }
  return pins
}

/**
 * Derive the curated moment index over one window: the five deterministic
 * candidate sources (S9b: burst ladder, dormancy returns, cross-line
 * convergence, long sittings, milestones), unified with the researcher's
 * pins. A pin on an event inside an existing candidate enriches that
 * moment; a pin on a lonely event promotes that event into its own moment.
 * An unpin demotes back to the candidate kind; a DECLINE (a `pinned:false`
 * on a never-canonical candidate) marks `declined` — the row stays
 * (append-only readability) but reads as refused, not unseen. Nothing is
 * ever removed from the fold — the index is a reading of the ledger, not
 * an edit of it.
 * @param events - ledger events, any order (observations already stripped
 * upstream; lookback prefix events may precede `since` and never anchor).
 * @param since - window start, inclusive (ISO-8601); `null` opens the window.
 * @param until - window end, exclusive (ISO-8601); `null` opens the window.
 * @returns the curated moments in time order, pinned ones never dropped.
 */
export function deriveCuratedMoments(
  events: readonly EventRecord[],
  since: string | null,
  until: string | null,
): readonly CbeCuratedMoment[] {
  const sinceMs = since === null ? Number.NEGATIVE_INFINITY : (tsToMs(since) ?? Number.NEGATIVE_INFINITY)
  const untilMs = until === null ? Number.POSITIVE_INFINITY : (tsToMs(until) ?? Number.POSITIVE_INFINITY)
  // The candidates fold over the full handed stream (so line history and the
  // eureka profile see their lookback), but anchors are window events only.
  const candidates = deriveMomentCandidates(events, sinceMs, untilMs)

  const pins = momentPins(events)
  // "Ever canonical" folds the pin history: a target whose declarations
  // ever carried pinned:true. It is what tells a DECLINE (never canonical,
  // refused on sight) from an UNPIN (was canonical, demoted) — the two
  // read differently in the index but live in the same append-only stream.
  const everPinned = new Set<string>()
  for (const event of orderedEvents(events)) {
    if (event.action !== MOMENT_PIN_ACTION) continue
    const target = event.payload['targetEventId']
    if (typeof target !== 'string') continue
    if (event.payload['pinned'] !== false) everPinned.add(target)
  }
  const windowed = sliceEvents(events, sinceMs, untilMs)
  const byId = new Map(windowed.map(event => [event.id, event] as const))
  const moments = new Map<string, CbeCuratedMoment>()

  for (const candidate of candidates) {
    const pin = pins.get(candidate.anchorEventId)
    const declined = pin !== undefined && !pin.pinned && !everPinned.has(candidate.anchorEventId)
    moments.set(candidate.anchorEventId, Object.freeze({
      id: candidate.anchorEventId,
      at: candidate.at,
      lineId: candidate.lineId,
      kind: pin !== undefined && pin.pinned ? 'pinned' : candidate.kind,
      sources: candidate.sources,
      action: anchorActionOf(windowed, candidate.anchorEventId) ?? candidate.kind,
      note: pin?.note !== undefined && pin.note !== '' ? pin.note : null,
      eventCount: candidate.stats.eventCount,
      pinned: pin?.pinned === true,
      declined,
      evidence: candidate.evidence,
      stats: candidate.stats,
      ews: candidate.ews,
      closeness: candidate.closeness,
    }))
  }

  // Pins on events the sources never proposed: the researcher saw something
  // the heuristics did not, which is the whole point of pinning.
  for (const [targetId, pin] of pins) {
    if (!pin.pinned || moments.has(targetId)) continue
    const target = byId.get(targetId)
    if (target === undefined) continue
    const lone = loneMomentOf(target)
    moments.set(targetId, lone)
  }

  return Object.freeze(
    [...moments.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
  )
}

/** The anchor event's own action name, when it is in the windowed stream. */
function anchorActionOf(windowed: readonly EventRecord[], anchorEventId: string): string | null {
  return windowed.find(event => event.id === anchorEventId)?.action ?? null
}

/** A pin-only moment: one event the sources never proposed, promoted by hand. */
function loneMomentOf(target: EventRecord): CbeCuratedMoment {
  return Object.freeze({
    id: target.id,
    at: target.ts,
    lineId: lineOf(target),
    kind: 'pinned',
    sources: [],
    action: target.action,
    note: null,
    eventCount: 1,
    pinned: true,
    declined: false,
    evidence: Object.freeze([target.id]),
    stats: Object.freeze({
      eventCount: 1,
      creationCount: 0,
      creationRatio: 0,
      netSignedWeight: 0,
      distinctLines: 0,
      lineCounts: [],
      spanMinutes: 0,
      distinctDays: 1,
    }),
    ews: Object.freeze({
      symbols: 1,
      distinct: 1,
      unigramEntropy: null,
      conditionalEntropy: null,
      order: 0,
      lag1MutualInformation: null,
      meanSurprisal: null,
    }),
    closeness: null,
  })
}
