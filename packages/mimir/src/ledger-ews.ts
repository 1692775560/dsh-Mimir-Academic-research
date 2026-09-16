/**
 * Ledger early-warning signals (EWS): the ledger read as a **discrete
 * symbolic sequence**, and the information-theoretic measures of how
 * predictable that sequence is.
 *
 * Why this module exists — and it is not an analogy:
 *
 * Tabatabaeian, O'bi, Landy & Marghetis (PNAS 2025, DOI 10.1073/pnas.2502791122)
 * recorded mathematicians' moment-to-moment blackboard activity and found
 * that sudden insights are preceded by their interactions becoming
 * **increasingly unpredictable** — the information-theoretic signature of
 * the critical fluctuations that anticipate a critical transition in
 * physical and ecological systems. They note the signal applies to systems
 * with **discrete, symbolic dynamics**, and that bibliometrics are too
 * coarse-grained to see it: it requires a dense, local record of the
 * researcher's own activity.
 *
 * The ledger IS that record, and its events ARE that symbol stream:
 * `knowledge.idea.added`, `literature.paper.imported`, `experiments.saved`…
 * So the quantity worth watching is not "how busy" — a busy fortnight and a
 * critical fortnight look identical in event counts — but **how
 * unpredictable the next action was, given the actions before it**.
 *
 * What is measured, and what each one is for:
 *  - `unigramEntropy` H₁ — the spread of action types (a first-order view).
 *  - `conditionalEntropy` H(k) — the uncertainty of the next action given
 *    the previous k. This is the paper's "increasingly unpredictable",
 *    operationalised.
 *  - `lag1MutualInformation` H₁ − H(1) — **symbolic persistence**. In
 *    numeric series, critical slowing down shows up as rising lag-1
 *    autocorrelation; for symbols the same idea is "how much does knowing
 *    the last action tell you about the next", which is exactly this
 *    quantity. It is computed from the same two entropies, so it costs
 *    nothing extra and needs no arbitrary numeric encoding.
 *  - `meanSurprisal` — the average −log₂ p of each event given its history:
 *    the point-wise trace of the fluctuation.
 *
 * Honest boundaries, registered rather than hidden:
 *  1. **Plug-in (MLE) entropy is biased low on small samples.** No Miller–
 *     Madow or NSB correction is applied. This is acceptable *because every
 *     number here is consumed as a CONTRAST* (eureka window minus paired
 *     control window, same estimator both sides), where the bias largely
 *     cancels. Absolute values must not be quoted as standalone facts.
 *  2. **Sample floor.** Below {@link CBE_EWS_MIN_EVENTS} symbols, the
 *     conditional quantities are `null` — a 12-event window cannot support
 *     an order-2 Markov estimate, and reporting one would be numerology.
 *  3. **Order is adaptive**, never fixed: k shrinks with sample size, so we
 *     never estimate more context than the data can carry.
 *  4. **Descriptive only.** Nothing here says "you are approaching an
 *     insight". It describes roads already walked; the lift is computed
 *     after the fact, against declared Eurekas, in {@link module:dsh-mimir/src/eureka}.
 * @module dsh-mimir/src/ledger-ews
 */

import { sliceEvents } from './time.ts'
import type { EventRecord } from './types.ts'

/** Symbols needed before conditional (order ≥ 1) quantities are reported. */
export const CBE_EWS_MIN_EVENTS = 12

/** The highest Markov order ever attempted (shrinks with sample size). */
export const CBE_EWS_MAX_ORDER = 3

/** Enough observations per context before an order is trusted. */
const CBE_EWS_MIN_OBS_PER_CONTEXT = 4

/** One EWS reading of one window — every conditional quantity nullable. */
export interface CbeEwsReading {
  /** Symbols in the window. */
  readonly symbols: number
  /** Distinct action types in the window. */
  readonly distinct: number
  /** H₁ in bits; null below the floor. */
  readonly unigramEntropy: number | null
  /** H(k) in bits; null below the floor or when no order is admissible. */
  readonly conditionalEntropy: number | null
  /** The order k actually used (0 when only H₁ is reported). */
  readonly order: number
  /** H₁ − H(1): symbolic persistence, the critical-slowing-down analogue. */
  readonly lag1MutualInformation: number | null
  /** Mean −log₂ p of each symbol given its k predecessors. */
  readonly meanSurprisal: number | null
}

/** Round to 6 decimals for stable serialization. */
function r6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/**
 * Project a window of the ledger onto its symbol stream: one symbol per
 * event, in time order. The action name is the symbol — the ledger's own
 * discrete vocabulary, unmodified. Unparseable timestamps are dropped
 * (they cannot be placed in a sequence). The window slice is the shared
 * {@link sliceEvents} so this agrees with every other fold on what is inside.
 * @param events - ledger events, any order.
 * @param fromMs - window start, inclusive (epoch ms).
 * @param toMs - window end, exclusive (epoch ms).
 * @returns the symbols in (ts, id) order.
 */
export function actionSequence(
  events: readonly EventRecord[],
  fromMs: number,
  toMs: number,
): readonly string[] {
  return sliceEvents(events, fromMs, toMs).map(event => event.action)
}

/** Shannon entropy in bits of one empirical distribution (counts → total). */
function entropyOfCounts(counts: ReadonlyMap<string, number>, total: number): number {
  if (total <= 0) return 0
  let h = 0
  for (const count of counts.values()) {
    if (count <= 0) continue
    const p = count / total
    h -= p * Math.log2(p)
  }
  return h
}

/**
 * H₁: the unigram entropy of the symbol stream, in bits. 0 for a stream
 * that repeats one action; log₂(n) for n equally likely actions.
 * @param symbols - the window's action sequence.
 * @returns the entropy in bits (0 for an empty sequence).
 */
export function unigramEntropy(symbols: readonly string[]): number {
  const counts = new Map<string, number>()
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1)
  return r6(entropyOfCounts(counts, symbols.length))
}

/**
 * The largest Markov order the sample can carry — and crucially, the order
 * SHRINKS as the action alphabet gets coarse, because a small alphabet needs
 * proportionally more observations to populate its contexts. The rule is
 * explicit: order k is admissible only when the sample can fill its contexts,
 * requiring `(n − k) ≥ distinct^k · CBE_EWS_MIN_OBS_PER_CONTEXT` on average.
 *
 * This is the opposite of "more symbols ⇒ higher order". The previous rule
 * let a 15-symbol window with a 14-letter alphabet estimate a 3rd-order
 * Markov — exactly the numerology the sample floor exists to forbid. With a
 * coarse ledger (the realistic case: a sparse stream of semantic actions),
 * higher orders are simply unavailable, and H(1) is the honest workhorse.
 * @param n - number of symbols.
 * @param distinct - number of distinct symbols.
 * @returns the admissible order (0..{@link CBE_EWS_MAX_ORDER}).
 */
export function ewsOrder(n: number, distinct: number): number {
  if (n < CBE_EWS_MIN_EVENTS) return 0
  for (let k = CBE_EWS_MAX_ORDER; k >= 1; k -= 1) {
    const contexts = n - k
    // Not even enough transitions to clear the floor at this order.
    if (contexts < CBE_EWS_MIN_EVENTS) break
    // Up to `distinct^k` contexts could appear; require each to be seen at
    // least CBE_EWS_MIN_OBS_PER_CONTEXT times before trusting the estimate.
    const needed = Math.pow(Math.max(distinct, 1), k) * CBE_EWS_MIN_OBS_PER_CONTEXT
    if (contexts >= needed) return k
  }
  return 1
}

/**
 * H(k): the conditional entropy of the next symbol given the previous k, in
 * bits — Σ_context p(context)·H(next | context). This is the
 * "increasingly unpredictable" measure: LOWER means the stream has settled
 * into routines, HIGHER means the next move is harder to guess.
 *
 * Returns `null` when the sample cannot carry the order (below the floor, or
 * fewer transitions than the order allows) — an unsupportable estimate is
 * never reported.
 * @param symbols - the window's action sequence.
 * @param order - the Markov order k (≥ 1).
 * @returns the conditional entropy in bits, or null.
 */
export function conditionalEntropy(
  symbols: readonly string[],
  order: number,
): number | null {
  if (order < 1) return null
  if (symbols.length < CBE_EWS_MIN_EVENTS) return null
  if (symbols.length - order < CBE_EWS_MIN_EVENTS) return null

  const byContext = new Map<string, Map<string, number>>()
  const contextTotals = new Map<string, number>()
  for (let i = order; i < symbols.length; i += 1) {
    const context = symbols.slice(i - order, i).join('\u0000')
    const next = symbols[i]
    if (next === undefined) continue
    const bucket = byContext.get(context) ?? new Map<string, number>()
    bucket.set(next, (bucket.get(next) ?? 0) + 1)
    byContext.set(context, bucket)
    contextTotals.set(context, (contextTotals.get(context) ?? 0) + 1)
  }
  const total = [...contextTotals.values()].reduce((sum, value) => sum + value, 0)
  if (total <= 0) return null
  let h = 0
  for (const [context, contextTotal] of contextTotals) {
    const bucket = byContext.get(context)
    if (bucket === undefined) continue
    h += (contextTotal / total) * entropyOfCounts(bucket, contextTotal)
  }
  return r6(h)
}

/**
 * Per-symbol surprisal: −log₂ p(symbol | its k predecessors), in bits. One
 * entry per symbol; the first `order` entries are `null` (no history yet).
 * This is the point-wise trace behind {@link conditionalEntropy}.
 * @param symbols - the window's action sequence.
 * @param order - the Markov order k (≥ 1).
 * @returns the surprisal of each position, or an all-null array.
 */
export function surprisalSequence(
  symbols: readonly string[],
  order: number,
): readonly (number | null)[] {
  if (order < 1 || symbols.length < CBE_EWS_MIN_EVENTS) {
    return symbols.map(() => null)
  }
  const byContext = new Map<string, Map<string, number>>()
  const contextTotals = new Map<string, number>()
  for (let i = order; i < symbols.length; i += 1) {
    const context = symbols.slice(i - order, i).join('\u0000')
    const next = symbols[i]
    if (next === undefined) continue
    const bucket = byContext.get(context) ?? new Map<string, number>()
    bucket.set(next, (bucket.get(next) ?? 0) + 1)
    byContext.set(context, bucket)
    contextTotals.set(context, (contextTotals.get(context) ?? 0) + 1)
  }
  return symbols.map((symbol, index) => {
    if (index < order) return null
    const context = symbols.slice(index - order, index).join('\u0000')
    const bucket = byContext.get(context)
    const total = contextTotals.get(context) ?? 0
    if (bucket === undefined || total <= 0) return null
    const p = (bucket.get(symbol) ?? 0) / total
    return p <= 0 ? null : r6(-Math.log2(p))
  })
}

/**
 * The whole EWS reading of one window: the spread of action types, how
 * predictable the next action was, how persistent the stream was, and the
 * average surprise — with every conditional quantity `null` below the
 * sample floor.
 * @param events - ledger events, any order.
 * @param fromMs - window start, inclusive (epoch ms).
 * @param toMs - window end, exclusive (epoch ms).
 * @returns the frozen reading.
 */
export function ewsReading(
  events: readonly EventRecord[],
  fromMs: number,
  toMs: number,
): CbeEwsReading {
  const symbols = actionSequence(events, fromMs, toMs)
  const distinct = new Set(symbols).size
  // H₁ from a handful of symbols describes the SAMPLE, not the process — and
  // a spuriously low H₁ (a three-event window reads as 0 bits, i.e. "perfectly
  // predictable") would corrupt the lift. So it waits for the floor too.
  const h1 = symbols.length < CBE_EWS_MIN_EVENTS ? null : unigramEntropy(symbols)
  const order = ewsOrder(symbols.length, distinct)
  const hk = order >= 1 ? conditionalEntropy(symbols, order) : null
  // Symbolic persistence: how much the previous action tells you about the
  // next. Same two entropies, so it costs nothing extra.
  const h1raw = h1 ?? 0
  const h2 = symbols.length >= CBE_EWS_MIN_EVENTS
    ? conditionalEntropy(symbols, 1)
    : null
  const lag1 = h2 === null || symbols.length < CBE_EWS_MIN_EVENTS
    ? null
    : r6(Math.max(0, h1raw - h2))
  const surprisals = order >= 1 ? surprisalSequence(symbols, order) : []
  const known = surprisals.filter((value): value is number => value !== null)
  const meanSurprisal = known.length === 0
    ? null
    : r6(known.reduce((sum, value) => sum + value, 0) / known.length)

  return Object.freeze({
    symbols: symbols.length,
    distinct,
    unigramEntropy: h1,
    conditionalEntropy: hk,
    order,
    lag1MutualInformation: lag1,
    meanSurprisal,
  })
}
