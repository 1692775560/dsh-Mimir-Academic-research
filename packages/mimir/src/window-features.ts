/**
 * Shared window-feature fold (L1): the ONE way any window of ledger activity
 * is turned into a feature vector, so that a "moment" and a "Eureka lead-in"
 * are measured with the same ruler.
 *
 * This module is the L1 extension of the L0 rule: windowing, ordering and
 * sessionization come ONLY from `time.ts` primitives (`sliceEvents` /
 * `orderedEvents` / `sessionize` / `tsToMs`) — hand-rolled copies of those
 * predicates are how folds used to drift apart, and are forbidden here.
 *
 * What one window is reduced to (field-for-field the eureka lead-in features
 * it replaces, so the two consumers can never measure differently):
 *  - first-order counts: creation-class events, total events, sittings (the
 *    map's own session gap), net signed weight, distinct local days;
 *  - the information-theoretic early-warning signals (`ledger-ews`), each
 *    `null` on its own when the window cannot carry it — a null is a refusal
 *    to estimate, never a zero.
 *
 * Discipline: pure fold over `events`, re-derived every time, never persisted
 * as fact (L1). Deterministic for a given input.
 * @module dsh-mimir/src/window-features
 */

import { CREATION_ACTIONS, lineOf, signedWeight } from './vocabulary.ts'
import { deriveSessions } from './habits.ts'
import { ewsReading } from './ledger-ews.ts'
import { sliceEvents, tsToMs } from './time.ts'
import type { EventRecord } from './types.ts'

/** The nine features of one window — the shared ruler of moments and Eurekas. */
export interface CbeWindowFeatures {
  /** Creation-class events (`knowledge.idea.added` and friends). */
  readonly creationCount: number
  readonly eventCount: number
  /** Sittings cut at the map's own session gap. */
  readonly sessionCount: number
  /** Net signed weight of the window's events (direction of the push). */
  readonly netSignedWeight: number
  /** Distinct local calendar days carrying at least one event. */
  readonly distinctDays: number
  /** H₁ — the spread of action types (bits). */
  readonly unigramEntropy: number | null
  /** H(k) — how unpredictable the next action was, given the last k (bits). */
  readonly conditionalEntropy: number | null
  /** H₁ − H(1) — symbolic persistence, the slowing-down analogue (bits). */
  readonly lag1MutualInformation: number | null
  /** Mean −log₂ p per event given its predecessors (bits). */
  readonly meanSurprisal: number | null
}

/** Round to 3 decimals for stable rendering/serialization. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Fold one window of the ledger into the shared nine-feature vector.
 * A window with no events folds to a zero vector (an honest zero, not a gap),
 * and the EWS fields go null on their own below their own sample floor.
 * @param events - ledger events, any order.
 * @param lineId - the line to measure, or null for every event.
 * @param fromMs - window start, inclusive (epoch ms).
 * @param toMs - window end, exclusive (epoch ms).
 * @returns the frozen feature vector.
 */
export function windowFeatures(
  events: readonly EventRecord[],
  lineId: string | null,
  fromMs: number,
  toMs: number,
): CbeWindowFeatures {
  // The shared slice decides what "in the window" means, and it hands the
  // events back in canonical order — which `deriveSessions` below requires.
  const inWindow = sliceEvents(events, fromMs, toMs)
    .filter(event => lineId === null || lineOf(event) === lineId)
  const days = new Set<string>()
  let netWeight = 0
  let creationCount = 0
  for (const event of inWindow) {
    const at = new Date(tsToMs(event.ts) ?? 0)
    days.add(`${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`)
    netWeight += signedWeight(event)
    if (CREATION_ACTIONS.has(event.action)) creationCount += 1
  }
  // The early-warning signals read the SAME window as a symbol stream. They
  // go null on their own when the sample cannot carry them.
  const ews = ewsReading(inWindow, fromMs, toMs)
  return Object.freeze({
    creationCount,
    eventCount: inWindow.length,
    sessionCount: deriveSessions(inWindow).length,
    netSignedWeight: r3(netWeight),
    distinctDays: days.size,
    unigramEntropy: ews.unigramEntropy,
    conditionalEntropy: ews.conditionalEntropy,
    lag1MutualInformation: ews.lag1MutualInformation,
    meanSurprisal: ews.meanSurprisal,
  })
}
