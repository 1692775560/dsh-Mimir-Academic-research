/**
 * The L0 vocabulary of the cognitive-beidou engine: the ledger's own language,
 * stated once, with no derivation attached.
 *
 * Why this module exists. These definitions used to live inside
 * `cognitive-map.ts` — an 826-line module whose actual job is the BRIEF, one
 * particular fold among eleven. Every other fold that needed to know what an
 * action *weighs* (`eureka`, `habits`, `cbe-engine`, `foraging`,
 * `moment-index`, `worktree`) therefore had to import the entire brief layer
 * just to read a constant. That is dependency inversion: the leaves were
 * importing a sibling's view, so adding a twelfth fold meant dragging the
 * brief along with it, and any change to the brief's module graph could break
 * six unrelated derivations.
 *
 * The vocabulary is not a fold. It is the language the folds are written in:
 *  - `LINE_WEIGHTS` / `signedWeight` — what one action is worth on its line.
 *  - `TERMINAL_ACTIONS` / `CREATION_ACTIONS` — which actions are which class.
 *  - `CBE_SESSION_GAP_MINUTES` — how wide a silence splits two sittings.
 *  - `isDecisionEvent` — whether an event may move a line at all.
 *
 * It owns no window, no ordering, and no aggregation. The mechanics of
 * *cutting* a stream by time live one layer down in `./time.ts`; vocabulary
 * merely supplies the numbers that parameterise those cuts. Nothing here
 * imports a fold, so this module can never participate in a dependency cycle.
 *
 * `cognitive-map.ts` re-exports every name here, so the existing `index.ts`
 * surface and any external import keep working unchanged.
 * @module dsh-mimir/src/vocabulary
 */

import type { EventRecord } from './types.ts'

/** Minutes of inactivity that split one session from the next. */
export const CBE_SESSION_GAP_MINUTES = 30

/**
 * Half-life (days) of the drift decay — a week-old investment weighs half.
 * A decay parameter that *cuts* a stream by time, so it lives in the L0
 * vocabulary next to `CBE_SESSION_GAP_MINUTES` rather than in the brief
 * view: the foraging and learning folds need it without importing the map.
 */
export const CBE_HALF_LIFE_DAYS = 7

/**
 * The signed weight of one action on its line, over the REAL ledger
 * vocabulary (all 25 decision-grade actions). Outcomes that sign by payload
 * (`compute.job.settled`, `knowledge.claim.set`) resolve in
 * {@link signedWeight}. Actions absent here weigh 0 (meta events like
 * `data.wiki.*` never move a line — and neither does the journal: `journal.*`
 * is the L2 layer, read by the map as the user's own words, never signed as
 * evidence).
 */
export const LINE_WEIGHTS: Readonly<Record<string, number>> = {
  'knowledge.idea.added': 2,
  'experiments.saved': 1.5,
  'compute.job.settled': 1,
  'literature.paper.imported': 1,
  'literature.pdf.fetched': 0.5,
  'writing.paper.reordered': 0.5,
  'writing.bib.saved': 0.5,
  'writing.bib.imported': 0.5,
  'literature.paper.removed': -1,
  'experiments.server.relinked': -0.5,
  'figures.deleted': -0.5,
  'compute.server.deleted': -0.5,
  'experiments.deleted': -1.5,
  'knowledge.idea.failed': -2.5,
  'knowledge.idea.adopted': 2.5, // the merge: the positive terminal, symmetric weight of the close
}

/** The boundary-crossing actions: the research's own decision institutions. */
export const TERMINAL_ACTIONS: ReadonlySet<string> = new Set([
  'knowledge.idea.failed',
  'knowledge.idea.adopted',
  'knowledge.claim.set',
])

/** Creation-class actions: the eureka detector requires at least one per session. */
export const CREATION_ACTIONS: ReadonlySet<string> = new Set([
  'knowledge.idea.added',
  'knowledge.claim.added',
  'literature.paper.imported',
  'experiments.saved',
  'figures.saved',
  'writing.paper.reordered',
])

/**
 * The signed weight of one event on its line (outcome-aware). Actions whose
 * direction lives in the payload rather than the name resolve here; every
 * other action reads {@link LINE_WEIGHTS}, and an unknown action weighs 0.
 * @param event - one ledger event.
 * @returns the signed weight (0 = it does not move the line).
 */
export function signedWeight(event: EventRecord): number {
  switch (event.action) {
    case 'compute.job.settled': {
      const status = typeof event.payload.status === 'string' ? event.payload.status : ''
      return status === 'succeeded' ? 1 : status === 'failed' ? -1 : 0
    }
    case 'knowledge.claim.set': {
      const status = typeof event.payload.status === 'string' ? event.payload.status : ''
      return status === 'supported' ? 2 : status === 'invalidated' ? -2 : 0
    }
    default:
      return LINE_WEIGHTS[event.action] ?? 0
  }
}

/**
 * Whether an event is DECISION-grade — that is, whether it may move a line at
 * all. An event that carries no signed weight (a journal entry, a wiki meta
 * event, a question-shown marker) is the researcher's narration or the
 * system's bookkeeping; it is recorded and it is readable, but it is not
 * evidence and it must never count toward a line's evidence mass.
 *
 * This predicate exists so the rule is stated ONCE. Counting every attributed
 * event let a handful of journal entries push a one-event line across the
 * evidence floor and start emitting state claims — and, worse, diluted the
 * dispersion and inflated the touched-session count enough to rewrite the
 * line's state outright. Any fold that counts attributed events counts
 * {@link isDecisionEvent} events.
 * @param event - one ledger event.
 * @returns true when the event carries a non-zero signed weight.
 */
export function isDecisionEvent(event: EventRecord): boolean {
  return signedWeight(event) !== 0
}

/**
 * The read-path meta events: the map observing itself. `generateBrief` writes
 * `cbe.question.showed` when it raises boundary questions, and answering one
 * writes `cbe.question.answered`. Neither is research activity — they are the
 * instrument's own ticks — so counting them as window mass would let opening
 * the panel repeatedly lift a line's evidence tier (I2) with zero research
 * behind it.
 *
 * Explicitly listed rather than excluded by the `cbe.` prefix: `cbe.eureka.set`
 * (`EUREKA_ACTION`), `cbe.mainline.set` and `cbe.moment.pin` are the
 * researcher's own declarations — decision-grade acts that MUST keep counting.
 * A prefix rule would silently discard them along with the instrument's ticks.
 */
export const OBSERVATION_ACTIONS: ReadonlySet<string> = new Set([
  'cbe.question.showed',
  'cbe.question.answered',
])

/**
 * Whether one event is the instrument observing itself rather than the
 * researcher acting (see {@link OBSERVATION_ACTIONS}).
 *
 * This is a *different* question from {@link isDecisionEvent}, and the two
 * must never be merged:
 *  - `isDecisionEvent` asks "may this event move a line's statistics?" — an
 *    observation event is excluded here too, but so is every zero-weight
 *    event (a journal entry, a wiki meta write).
 *  - `isObservationEvent` asks "is this event the act of observation itself?"
 *    — a narrower class, used to keep the instrument's own ticks out of the
 *    window's mass so that opening a panel cannot inflate an evidence tier.
 *
 * An observation event must be excluded from a window's mass *whether or not*
 * it carries weight, and a zero-weight event must be excluded from a line's
 * statistics *whether or not* it is an observation. Neither predicate implies
 * the other.
 * @param event - one ledger event.
 * @returns true when the event must not count as research activity.
 */
export function isObservationEvent(event: EventRecord): boolean {
  return OBSERVATION_ACTIONS.has(event.action)
}

/**
 * The line an event attributes to — the idea first, then the project it
 * belongs to, or null when it is unscoped.
 *
 * "Which line does this event count toward" is decided by the ledger's own
 * reference shape, so exactly one function may answer it. Three folds used to
 * carry a verbatim copy of this body, which is three places for the
 * attribution rule to drift apart.
 * @param event - one ledger event.
 * @returns the line id (`<ideaId>` or `project:<projectId>`), or null.
 */
export function lineOf(event: EventRecord): string | null {
  if (event.refs.ideaId !== undefined) return event.refs.ideaId
  if (event.refs.projectId !== undefined) return `project:${event.refs.projectId}`
  return null
}
