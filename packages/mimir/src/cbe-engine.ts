/**
 * CBE learning engine (batch 4): RLDDM-inspired online prior updating —
 * NOT RLDDM, and the name says so. The hand weights of `LINE_WEIGHTS` are
 * treated exactly as PRIORS; terminal outcomes (a claim ruled, an idea
 * failed) nudge them per action through share-form credit assignment.
 *
 * The engine is a PURE FOLD over the ledger: `evidenceModelAt(events)` =
 * fold(updateOnTerminal, initialModel, terminals) — learned, yet stateless
 * and fully re-derivable (constitution-compatible: L1 is never persisted
 * as fact). Cold start ≡ today's map: with no terminals the effective
 * values ARE the priors, exactly.
 *
 * Three declared, non-bridgeable differences from RLDDM (standing record):
 *  1. no reaction-time analog — the ledger has no RT;
 *  2. no trial-level joint likelihood — declared never (group-level
 *     likelihoods are not ours to pool);
 *  3. no cross-user pooling — one user, one ledger, one model.
 *
 * G0 status: synthetic ordering/sign recovery, null invariance, and
 * determinism are proven in `tests/cbe-engine.spec.ts` (SBC spirit:
 * recover known ground truth before touching real claims). The engine may
 * exist in the codebase but UNTIL G1 PASSES IT FEEDS NO UI — the profile
 * remote is read-only instrumentation, not product copy.
 * @module dsh-mimir/src/cbe-engine
 */

import { CBE_HALF_LIFE_DAYS } from './vocabulary.ts'
import { LINE_WEIGHTS, TERMINAL_ACTIONS, lineOf } from './vocabulary.ts'
import type { EventRecord } from './types.ts'
import { MS_PER_DAY, orderedEvents, tsToMs } from './time.ts'

/** α — the learning rate per terminal (share-scaled). */
export const CBE_ENGINE_ALPHA = 0.3
/** κ — prior pseudo-mass: how much the hand priors weigh against data. */
export const CBE_ENGINE_KAPPA = 6
/** Sign-lock quorum: contrary mass needed before a prior's sign may flip. */
export const CBE_ENGINE_N_FLIP = 3
/** How many days back a terminal's eligibility window reaches. */
export const CBE_ENGINE_FOLD_WINDOW_DAYS = 180


/** One action's learned value: share-accumulated mean and mass. */
export interface CbeActionValue {
  /** Decaying mean of outcomes, accumulated as `mean += α·y·share`. */
  readonly mean: number
  /** Accumulated eligibility share (how often this action preceded terminals). */
  readonly mass: number
}

/** The whole learned model: one value per action, plus fold metadata. */
export interface CbeEvidenceModel {
  readonly values: ReadonlyMap<string, CbeActionValue>
  readonly derivation: {
    readonly version: number
    readonly terminalsFolded: number
  }
}

/** The engine's fold metadata version (mirrors CBE_DERIVATION_VERSION). */
const ENGINE_DERIVATION_VERSION = 2

/** Round to 6 decimals for stable serialization. */
function r6(value: number): number {
  return Math.round(value * 1_000_000) / 1000_000
}


/**
 * The outcome signal of one terminal event, sign-only: a supported claim
 * or an adopted idea (a declared merge) is +1, an invalidated claim or a
 * failed idea is −1, anything else 0
 * (and 0 never folds — a pending re-set decides nothing). Without the
 * adopted +1 the profile would learn only from failures — systematic
 * pessimism.
 */
export function terminalOutcome(event: EventRecord): -1 | 0 | 1 {
  if (event.action === 'knowledge.idea.failed') return -1
  if (event.action === 'knowledge.idea.adopted') return 1
  if (event.action === 'knowledge.claim.set') {
    const status = typeof event.payload.status === 'string' ? event.payload.status : ''
    if (status === 'supported') return 1
    if (status === 'invalidated') return -1
  }
  return 0
}

/** Whether one event is DECISION-grade (a terminal whose outcome folds). */
export function isTerminalOutcome(event: EventRecord): boolean {
  return TERMINAL_ACTIONS.has(event.action) && terminalOutcome(event) !== 0
}

/** The cold model: empty values — every effective value is its prior. */
export function initialModel(): CbeEvidenceModel {
  return Object.freeze({
    values: new Map<string, CbeActionValue>(),
    derivation: Object.freeze({ version: ENGINE_DERIVATION_VERSION, terminalsFolded: 0 }),
  })
}

/**
 * The κ-shrunk effective value of one action:
 * `(mass·mean + κ·prior) / (mass + κ)` — sparse evidence stays near the
 * prior (mathematical conservatism: few terminals ⇒ ≈ today's map).
 * @param model - the folded model.
 * @param action - the ledger action name.
 * @returns the effective signed value.
 */
export function effectiveValue(model: CbeEvidenceModel, action: string): number {
  const prior = LINE_WEIGHTS[action] ?? 0
  const value = model.values.get(action)
  if (value === undefined) return prior
  const total = value.mass + CBE_ENGINE_KAPPA
  return r6((value.mass * value.mean + CBE_ENGINE_KAPPA * prior) / total)
}

/**
 * One fold step: apply a terminal outcome to the model, crediting the
 * line's prior actions by kernel-decayed share (replacing-trace spirit,
 * Singh & Sutton 1996: the share form is what ties credit to the
 * max-earning allocation without bookkeeping ghosts).
 *
 * Eligibility: the line's events BEFORE the terminal, inside the fold
 * window, whose actions carry a prior (LINE_WEIGHTS member). Each event
 * decays toward the terminal by the same half-life the map uses; an
 * action's share = its decayed mass over the line's decayed total.
 *
 * Sign lock: while an action's mass is below {@link CBE_ENGINE_N_FLIP},
 * its mean may not cross to the prior's opposite side — one noisy
 * terminal cannot flip a hand prior; three full shares of contrary
 * evidence can.
 * @param model - the model so far.
 * @param terminal - the terminal event (outcome ≠ 0).
 * @param lineEvents - the line's events (any order; filtered internally).
 * @returns the next model.
 */
export function updateOnTerminal(
  model: CbeEvidenceModel,
  terminal: EventRecord,
  lineEvents: readonly EventRecord[],
): CbeEvidenceModel {
  const outcome = terminalOutcome(terminal)
  if (outcome === 0) return model
  const terminalMs = tsToMs(terminal.ts)
  if (terminalMs === null) return model
  const line = lineOf(terminal)
  if (line === null) return model

  // Eligible: same line, before the terminal, inside the window, weighted action.
  const windowStart = terminalMs - CBE_ENGINE_FOLD_WINDOW_DAYS * MS_PER_DAY
  const decayed = new Map<string, number>()
  let total = 0
  for (const event of lineEvents) {
    if (lineOf(event) !== line || event.id === terminal.id) continue
    const ms = tsToMs(event.ts)
    if (ms === null || ms > terminalMs || ms < windowStart) continue
    if (!(event.action in LINE_WEIGHTS)) continue
    // The map's own half-life — not a 7 typed here. A second literal copy of
    // the decay constant is how the two silently drift apart.
    const decay = Math.exp(-Math.LN2 * (terminalMs - ms) / (CBE_HALF_LIFE_DAYS * MS_PER_DAY))
    decayed.set(event.action, (decayed.get(event.action) ?? 0) + decay)
    total += decay
  }
  if (total <= 0) return model

  const values = new Map(model.values)
  for (const [action, mass] of [...decayed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const share = mass / total
    const current = values.get(action) ?? { mean: 0, mass: 0 }
    let mean = current.mean + CBE_ENGINE_ALPHA * outcome * share
    const nextMass = current.mass + share
    // Sign lock — released at the quorum.
    const prior = LINE_WEIGHTS[action] ?? 0
    if (prior > 0 && mean < 0 && nextMass < CBE_ENGINE_N_FLIP) mean = 0
    if (prior < 0 && mean > 0 && nextMass < CBE_ENGINE_N_FLIP) mean = 0
    values.set(action, { mean: r6(mean), mass: r6(nextMass) })
  }
  return Object.freeze({
    values,
    derivation: Object.freeze({
      version: ENGINE_DERIVATION_VERSION,
      terminalsFolded: model.derivation.terminalsFolded + 1,
    }),
  })
}

/**
 * Fold the whole model over a ledger stream (G0's determinism surface):
 * events sort by (ts, id) regardless of input order, terminals apply in
 * time order, and each terminal sees only the events its line had
 * accumulated before it. Unattributable terminals (no idea/project ref)
 * are skipped honestly — today's claim events carry no line ref.
 * @param events - ledger events, any order.
 * @returns the folded model.
 */
export function evidenceModelAt(events: readonly EventRecord[]): CbeEvidenceModel {
  const ordered = orderedEvents(events)
  const byLine = new Map<string, EventRecord[]>()
  let model = initialModel()
  for (const event of ordered) {
    const line = lineOf(event)
    if (line !== null && isTerminalOutcome(event)) {
      const lineEvents = byLine.get(line) ?? []
      model = updateOnTerminal(model, event, lineEvents)
    }
    if (line !== null) {
      const list = byLine.get(line) ?? []
      list.push(event)
      byLine.set(line, list)
    }
  }
  return model
}

/** One row of the read-only evidence profile (the remote's payload). */
export interface CbeEvidenceActionRow {
  readonly action: string
  readonly prior: number
  readonly mean: number
  readonly mass: number
  readonly effectiveValue: number
}

/**
 * The model as a sorted, serializable profile (the `getEvidenceProfile`
 * payload): one row per action with a prior OR learned mass, effective
 * value descending. Read-only instrumentation — nothing consumes it in the
 * UI until G1 passes, and the profile must never be used as a
 * self-optimization performance metric (its job is honest priors, not
 * leaderboard copy).
 * @param model - the folded model.
 * @returns the profile rows plus fold metadata.
 */
export function evidenceProfileOf(model: CbeEvidenceModel): {
  readonly derivation: CbeEvidenceModel['derivation']
  readonly actions: readonly CbeEvidenceActionRow[]
} {
  const actions = new Set<string>([...Object.keys(LINE_WEIGHTS), ...model.values.keys()])
  const rows: CbeEvidenceActionRow[] = [...actions].sort((a, b) => a.localeCompare(b)).map(action => {
    const value = model.values.get(action)
    return Object.freeze({
      action,
      prior: LINE_WEIGHTS[action] ?? 0,
      mean: value?.mean ?? 0,
      mass: value?.mass ?? 0,
      effectiveValue: effectiveValue(model, action),
    })
  })
  rows.sort((a, b) => b.effectiveValue - a.effectiveValue || a.action.localeCompare(b.action))
  return Object.freeze({
    derivation: model.derivation,
    actions: Object.freeze(rows),
  })
}
