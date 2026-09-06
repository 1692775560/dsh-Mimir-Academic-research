/**
 * CBE eureka engine (S8): the DECLARED milestone, and the shape of the road
 * that led to it.
 *
 * The division of labour is the whole point of this module, and it is not a
 * compromise — it is the origin rule applied to insight:
 *
 *  1. **A Eureka is declared, never detected.** Only the researcher knows
 *     which moment was the one where the picture changed. The system that
 *     announces "you just had a breakthrough" is not a secretary, it is a
 *     fortune teller, and a wrong announcement is worse than silence.
 *  2. **But the road to it is learnable.** The lead-in window — what the
 *     ledger recorded in the fortnight before each declared Eureka — is a
 *     real, observed shape. Folding those windows together IS the 量变引起
 *     质变 the researcher suspects: it turns "I feel like breakthroughs
 *     follow busy weeks" into "your declared Eurekas followed windows with
 *     6.3 creation events, against 2.1 in the fortnight before that".
 *
 * So the engine produces a DESCRIPTIVE precursor profile: per-feature means
 * over eureka lead-ins against paired control windows, plus the lift. It
 * never predicts, never scores a moment, and never tells the researcher they
 * are "on track" — that would be the system claiming to know what comes
 * next, which is exactly what it cannot know.
 *
 * Discipline inherited from {@link module:dsh-mimir/src/cbe-engine}:
 *  - **Pure fold**: `eurekaModelAt(events)` re-derives everything, so the
 *    profile is L1 and is never persisted as fact.
 *  - **Matched controls**: each Eureka's lead-in is paired with the
 *    equal-length window immediately BEFORE it. Deterministic, no sampling,
 *    no randomness — and honestly limited (see the registered note below).
 *  - **Silence below the floor**: under {@link CBE_EUREKA_MIN_DECLARATIONS}
 *    the lift stays null. Two data points are an anecdote wearing a
 *    confidence interval.
 *  - **G0 status**: like the evidence engine, this feeds NO UI until G1
 *    passes. It exists so the comparison is inspectable when that day comes.
 *  - **No cross-user pooling**: one researcher, one ledger, one model.
 *
 * Registered v1 limitation: the paired control window (the fortnight BEFORE
 * the lead-in) can itself contain the start of the ramp, which biases the
 * lift DOWNWARD — the engine under-reports rather than over-reports. That
 * is the honest direction to err.
 * @module dsh-mimir/src/eureka
 */

import { lineOf } from './vocabulary.ts'
import { windowFeatures } from './window-features.ts'
import type { CbeWindowFeatures } from './window-features.ts'
import { ewsReading } from './ledger-ews.ts'
import type { CbeEwsReading } from './ledger-ews.ts'
import { MS_PER_DAY, orderedEvents, tsToMs } from './time.ts'
import type { EventRecord } from './types.ts'

/** The user's declared Eureka milestone (one append-only declaration). */
export const EUREKA_ACTION = 'cbe.eureka.set'

/** How many days before a declared Eureka count as its lead-in. */
export const CBE_EUREKA_WINDOW_DAYS = 14

/** Declared Eurekas before the lift may speak (I2's floor). */
export const CBE_EUREKA_MIN_DECLARATIONS = 3

/**
 * The features of one lead-in window: first-order counts PLUS the
 * information-theoretic early-warning signals. The EWS fields are `null`
 * whenever the window cannot carry them (below `CBE_EWS_MIN_EVENTS`
 * symbols) — a null is a refusal to estimate, never a zero.
 *
 * Type alias: the lead-in features ARE the shared window features
 * (`window-features.ts`); the name is kept for signature compatibility.
 */
export type CbeEurekaFeatures = CbeWindowFeatures

/** The feature keys the profile reports, in report order. */
export const EUREKA_FEATURE_KEYS = [
  'creationCount', 'eventCount', 'sessionCount', 'netSignedWeight', 'distinctDays',
  'unigramEntropy', 'conditionalEntropy', 'lag1MutualInformation', 'meanSurprisal',
] as const

export type CbeEurekaFeatureKey = typeof EUREKA_FEATURE_KEYS[number]

/** One user-declared Eureka milestone. */
export interface CbeEurekaDeclaration {
  readonly id: string
  /** The idea line, or `project:<id>`; null when the declaration is unscoped. */
  readonly lineId: string | null
  readonly at: string
  /** The researcher's own words for the milestone. */
  readonly title: string
}

/** One feature's accumulated comparison (the profile's row). */
export interface CbeEurekaFeatureRow {
  readonly feature: CbeEurekaFeatureKey
  /** Mean over the declared Eurekas' lead-in windows; null if none reported. */
  readonly eurekaMean: number | null
  /** Mean over the paired control windows; null if none reported. */
  readonly controlMean: number | null
  /**
   * `eurekaMean − controlMean`; null while the floor is not met, or when
   * either side went unreported. A lift we cannot observe is not a zero lift.
   */
  readonly lift: number | null
  /** Paired windows folded (one per declared Eureka). */
  readonly samples: number
}

/** The whole folded model (L1: re-derivable, never persisted). */
export interface CbeEurekaModel {
  readonly declarations: readonly CbeEurekaDeclaration[]
  /** Lead-in feature vectors, one per declaration. */
  readonly leads: readonly CbeEurekaFeatures[]
  /** Paired control feature vectors, one per declaration. */
  readonly controls: readonly CbeEurekaFeatures[]
}

/** The profile the (future) view consumes — descriptive, never predictive. */
export interface CbeEurekaProfile {
  readonly derivedAt: string
  readonly declarationCount: number
  readonly speaks: boolean
  readonly minDeclarations: number
  readonly windowDays: number
  readonly rows: readonly CbeEurekaFeatureRow[]
}

/** Round to 3 decimals for stable rendering/serialization. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Read the declared Eureka milestones off the ledger. A declaration is the
 * researcher's own call — an unparseable timestamp is skipped rather than
 * guessed at, and a declaration with no line ref is kept (an unscoped
 * milestone is still a milestone).
 * @param events - ledger events, any order.
 * @returns the declarations in time order.
 */
export function eurekaDeclarations(events: readonly EventRecord[]): readonly CbeEurekaDeclaration[] {
  const out: CbeEurekaDeclaration[] = []
  for (const event of orderedEvents(events)) {
    if (event.action !== EUREKA_ACTION) continue
    if (tsToMs(event.ts) === null) continue
    const title = typeof event.payload.title === 'string' ? event.payload.title : ''
    out.push(Object.freeze({
      id: event.id,
      lineId: lineOf(event),
      at: event.ts,
      title,
    }))
  }
  return Object.freeze(out)
}

/**
 * The E0 feature vector of one window on one line: creation events, total
 * events, sittings, the net signed push, and the distinct active days.
 * Windows with no events fold to a zero vector (an honest zero, not a gap).
 * Thin delegation to the shared fold (`window-features.ts`) — a Eureka
 * lead-in and any other window consumer measure with the same ruler.
 * @param events - ledger events, any order.
 * @param lineId - the line to measure, or null for every event.
 * @param fromMs - window start, inclusive (epoch ms).
 * @param toMs - window end, exclusive (epoch ms).
 * @returns the frozen feature vector.
 */
export function eurekaFeatures(
  events: readonly EventRecord[],
  lineId: string | null,
  fromMs: number,
  toMs: number,
): CbeEurekaFeatures {
  return windowFeatures(events, lineId, fromMs, toMs)
}

/**
 * The lead-in / control window bounds for one declaration, anchored on its
 * timestamp. Both the folded model, the critical-state collector AND the
 * declaration-time context receipt (`eurekaContextAt`) MUST derive their
 * windows from this so the control-observability rule — "a control that
 * would start before the ledger begins is not a control we estimate" — is
 * enforced in exactly one place. Exporting it is the strengthening of that
 * single-source-of-window-semantics rule, not a loosening.
 * @param atMs - the declaration instant (epoch ms).
 * @param earliestMs - the ledger's first event time (the floor).
 * @returns the bounds (never null — the caller already parsed the instant).
 */
export interface EurekaWindowBounds {
  /** The declaration instant (epoch ms). */
  readonly atMs: number
  /** Lead-in window start (epoch ms); the window is [leadFrom, atMs). */
  readonly leadFrom: number
  /** Control window start (epoch ms); the window is [controlFrom, leadFrom). */
  readonly controlFrom: number
  /** false when the control would start before the ledger — unobservable. */
  readonly observable: boolean
}

export function eurekaWindowBounds(atMs: number, earliestMs: number): EurekaWindowBounds {
  const leadFrom = atMs - CBE_EUREKA_WINDOW_DAYS * MS_PER_DAY
  const controlFrom = atMs - 2 * CBE_EUREKA_WINDOW_DAYS * MS_PER_DAY
  return Object.freeze({
    atMs,
    leadFrom,
    controlFrom,
    observable: controlFrom >= earliestMs,
  })
}

/**
 * Fold the whole model: every declared Eureka contributes its lead-in
 * window, paired with the equal-length window immediately before it on the
 * same line. Unparseable or pre-history declarations (a control window that
 * would start before the ledger begins) are skipped honestly — a control we
 * cannot observe is not a control we estimate.
 * @param events - ledger events, any order.
 * @returns the folded model.
 */
export function eurekaModelAt(events: readonly EventRecord[]): CbeEurekaModel {
  const stream = orderedEvents(events)
  const declarations = eurekaDeclarations(stream)
  const earliestMs = stream.length === 0 ? 0 : (tsToMs(stream[0]?.ts ?? '') ?? 0)

  const leads: CbeEurekaFeatures[] = []
  const controls: CbeEurekaFeatures[] = []
  const usable: CbeEurekaDeclaration[] = []
  for (const declaration of declarations) {
    const atMs = tsToMs(declaration.at)
    if (atMs === null) continue
    const bounds = eurekaWindowBounds(atMs, earliestMs)
    if (!bounds.observable) continue
    leads.push(eurekaFeatures(stream, declaration.lineId, bounds.leadFrom, bounds.atMs))
    controls.push(eurekaFeatures(stream, declaration.lineId, bounds.controlFrom, bounds.leadFrom))
    usable.push(declaration)
  }
  return Object.freeze({
    declarations: Object.freeze(usable),
    leads: Object.freeze(leads),
    controls: Object.freeze(controls),
  })
}

/**
 * Mean of one feature across feature vectors. EWS features may be `null`
 * (a window too small to estimate), and a null is SKIPPED rather than
 * counted as zero — averaging refusals into the mean would quietly invent
 * the very numbers the floor exists to prevent.
 * @returns the mean, or null when no window reported this feature.
 */
function meanOf(
  rows: readonly CbeEurekaFeatures[],
  key: CbeEurekaFeatureKey,
): number | null {
  const values: number[] = []
  for (const row of rows) {
    const value = row[key]
    if (typeof value === 'number') values.push(value)
  }
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * The model as a descriptive profile: per-feature eureka mean, control mean,
 * and lift — null until {@link CBE_EUREKA_MIN_DECLARATIONS} declarations
 * exist. This is a description of roads already walked, NOT a predictor:
 * nothing here says a current window "looks like" a Eureka.
 * @param model - the folded model.
 * @param nowMs - "now" in epoch ms (injectable for determinism).
 * @returns the profile, silent below the floor.
 */
export function eurekaProfileOf(model: CbeEurekaModel, nowMs: number): CbeEurekaProfile {
  const samples = model.leads.length
  const speaks = samples >= CBE_EUREKA_MIN_DECLARATIONS
  const rows: CbeEurekaFeatureRow[] = EUREKA_FEATURE_KEYS.map(feature => {
    const eurekaMean = meanOf(model.leads, feature)
    const controlMean = meanOf(model.controls, feature)
    const lift = speaks && eurekaMean !== null && controlMean !== null
      ? r3(eurekaMean - controlMean)
      : null
    return Object.freeze({
      feature,
      eurekaMean: eurekaMean === null ? null : r3(eurekaMean),
      controlMean: controlMean === null ? null : r3(controlMean),
      lift,
      samples,
    })
  })
  return Object.freeze({
    derivedAt: new Date(nowMs).toISOString(),
    declarationCount: samples,
    speaks,
    minDeclarations: CBE_EUREKA_MIN_DECLARATIONS,
    windowDays: CBE_EUREKA_WINDOW_DAYS,
    rows: Object.freeze(rows),
  })
}

/**
 * One collected critical-state sample: a user-DECLARED Eureka, with the full
 * EWS reading of its lead-in window and its paired control window. This is
 * the dataset a learning process would consume — every declared insight,
 * described, never inferred.
 *
 * This is the honest answer to "collect the user's critical-state data for
 * analysis and learning": the system GATHERS the lead-in entropy of each
 * milestone the researcher themselves named, and pairs it with the equal
 * window before. It does NOT turn this into a prompt — no "you are
 * approaching an insight" is ever emitted from this data. Collection and
 * prompting are deliberately separate; only collection lives here.
 * @module dsh-mimir/src/eureka
 */
export interface CbeCriticalStateSample {
  /** The declaration event id the sample is anchored to. */
  readonly declarationId: string
  readonly at: string
  readonly title: string
  /** The full EWS reading of the fortnight BEFORE the declared milestone. */
  readonly lead: CbeEwsReading
  /** The full EWS reading of the fortnight BEFORE that (the control). */
  readonly control: CbeEwsReading
}

/**
 * Collect the descriptive critical-state dataset over every declared Eureka:
 * each milestone's lead-in EWS reading paired with its control. Pure and
 * silent — it returns an empty array when no milestone has been declared, and
 * it never writes, never prompts, never predicts.
 * @param events - ledger events, any order.
 * @returns the samples in declaration order (empty when none).
 */
export function eurekaCriticalStateData(events: readonly EventRecord[]): readonly CbeCriticalStateSample[] {
  const stream = orderedEvents(events)
  const declarations = eurekaDeclarations(stream)
  const earliestMs = stream.length === 0 ? 0 : (tsToMs(stream[0]?.ts ?? '') ?? 0)
  const samples: CbeCriticalStateSample[] = []
  for (const declaration of declarations) {
    // Same window bounds as the folded model — the collector no longer skips
    // the control-observability rule, so "which Eurekas count" is identical
    // whichever path the (future) view takes.
    const atMs = tsToMs(declaration.at)
    if (atMs === null) continue
    const bounds = eurekaWindowBounds(atMs, earliestMs)
    if (!bounds.observable) continue
    samples.push(Object.freeze({
      declarationId: declaration.id,
      at: declaration.at,
      title: declaration.title,
      lead: ewsReading(stream, bounds.leadFrom, bounds.atMs),
      control: ewsReading(stream, bounds.controlFrom, bounds.leadFrom),
    }))
  }
  return Object.freeze(samples)
}

/**
 * The declaration-time context receipt: what the shared fold says about the
 * fortnight leading up to an instant, paired with its control window. This is
 * what `setEurekaRemote` hands back WITH the stored declaration event — the
 * researcher declares, and immediately sees the road that led there, measured
 * with the same ruler as the retrospective model.
 *
 * Pure derivation, never persisted as fact: recomputing it later over the
 * same ledger yields the same numbers. The control is `null` when the ledger
 * does not reach back far enough to observe it (I2: unobservable is not
 * estimated). Describes only — it never evaluates the declaration.
 */
export interface CbeEurekaContextView {
  /** The lead-in window length the features cover. */
  readonly windowDays: number
  /** false when the control window would start before the ledger begins. */
  readonly observable: boolean
  /** The fortnight (windowDays) BEFORE the instant, folded. */
  readonly lead: CbeWindowFeatures
  /** The equal-length window before that; null when unobservable. */
  readonly control: CbeWindowFeatures | null
}

/**
 * Fold the declaration-time context for one instant: the lead-in window and
 * its paired control, both measured by the shared window fold.
 * @param events - ledger events, any order.
 * @param atMs - the declaration instant (epoch ms).
 * @param lineId - the line to scope the windows to, or null for every event.
 * @returns the frozen context view (control null when unobservable).
 */
export function eurekaContextAt(
  events: readonly EventRecord[],
  atMs: number,
  lineId?: string | null,
): CbeEurekaContextView {
  const stream = orderedEvents(events)
  const earliestMs = stream.length === 0 ? 0 : (tsToMs(stream[0]?.ts ?? '') ?? 0)
  const bounds = eurekaWindowBounds(atMs, earliestMs)
  const scope = lineId ?? null
  return Object.freeze({
    windowDays: CBE_EUREKA_WINDOW_DAYS,
    observable: bounds.observable,
    lead: windowFeatures(stream, scope, bounds.leadFrom, bounds.atMs),
    control: bounds.observable
      ? windowFeatures(stream, scope, bounds.controlFrom, bounds.leadFrom)
      : null,
  })
}
