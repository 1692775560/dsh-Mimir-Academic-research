/**
 * CBE worktree (S2): the research process rendered as a git-like working
 * tree — branches (idea lines), branch points (user-declared derivation
 * edges), dead ends (a documented No, first-class and never garbage
 * collected), merges (adopted lines / adjudicated claims), and ONE mainline
 * carried as a movable ref whose reflog is the history of mainline moves.
 *
 * Everything here is a PURE fold over (events, wiki records, now): the view
 * is L0 data wearing tree semantics, so it needs no gate — it is E0 by
 * construction (numbers, dates, and user-declared edges only; no inferred
 * genealogy, no optimization language).
 *
 * Git↔research differences are CONTRACT here, not metaphor (user mandate):
 *  1. the ledger is append-only — research history is never rebased;
 *  2. a "merge" is an adjudication by a person, not a mechanical text
 *     convergence — contradictions stay visible, they are not resolved;
 *  3. dead branches are never pruned: every ✗ is a documented No;
 *  4. derivation edges are DECLARED by the surveyor (origin rule: whoever
 *     bears the uncertainty of the claim owns it) — the system never infers
 *     a parent from text similarity;
 *  5. the mainline is a declared ref the user moves; the system never moves
 *     it and never ranks lines into it;
 *  6. lanes do not imply parallel work — research attention is serial, so a
 *     lane is a direction of record, not a claim of concurrency.
 *
 * The two new actions (`cbe.mainline.set`, `cbe.idea.parent.set`) carry no
 * LINE_WEIGHTS entry, so they never move a line's drift; like journal lines
 * they still ride their line as zero-weight touches (attention spent
 * structuring the map is attention spent on the line).
 * @module dsh-mimir/src/worktree
 */

import { deriveLines } from './cognitive-map.ts'
import type { CbeLineState, CbeWikiSnapshot } from './cognitive-map.ts'
import { CREATION_ACTIONS, LINE_WEIGHTS } from './vocabulary.ts'
import type { EventRecord } from './types.ts'
import { MS_PER_DAY, orderedEvents, tsToMs } from './time.ts'

/** The mainline-ref move: one append-only declaration of the current mainline. */
export const MAINLINE_ACTION = 'cbe.mainline.set'

/** The user-declared derivation edge: child rides `refs.ideaId`, parent rides the payload. */
export const IDEA_PARENT_ACTION = 'cbe.idea.parent.set'

/**
 * Cap of one close reason (the documented No's one-line lesson). Mirrored
 * client-side as `WORKTREE_REASON_MAX_CHARS`; registered into
 * PARAMETER_REGISTRY with batch 3.
 */
export const IDEA_CLOSE_REASON_MAX_CHARS = 48

/** Lifecycle of one lane as the worktree renders it. */
export type CbeWorktreeLaneStatus = 'open' | 'failed' | 'adopted'

/** How one touch reads on the branch graph's bead scale. */
export type CbeWorktreeTouchKind = 'create' | 'work' | 'meta' | 'terminal'

/** One work node on a lane: a timestamp, its bead class, and the action. */
export interface CbeWorktreeTouch {
  readonly at: string
  readonly kind: CbeWorktreeTouchKind
  /** The ledger action name (labels resolve client-side). */
  readonly action: string
}

/**
 * Classify one event into a bead kind for the branch graph: terminals
 * (decided outcomes) are the largest beads, creations (eureka-class
 * actions) next, weighted work mid, and zero-weight touches (journal
 * lines, meta events) the smallest — attention, still on the record.
 * Mirrors weightIsOutcomeTerminal's claim logic locally (not exported).
 */
function touchKindOf(event: EventRecord): CbeWorktreeTouchKind {
  if (event.action === 'knowledge.idea.failed' || event.action === 'knowledge.idea.adopted') return 'terminal'
  if (event.action === 'knowledge.claim.set') {
    const status = typeof event.payload.status === 'string' ? event.payload.status : ''
    if (status === 'supported' || status === 'invalidated') return 'terminal'
  }
  if (CREATION_ACTIONS.has(event.action)) return 'create'
  if ((LINE_WEIGHTS[event.action] ?? 0) !== 0) return 'work'
  return 'meta'
}

/** One lane of the worktree: a research line wearing branch semantics. */
export interface CbeWorktreeLane {
  /** Idea id, or `project:<id>` for project-level lines. */
  readonly lineId: string
  /** Idea/project title when the wiki record is present. */
  readonly label: string
  readonly status: CbeWorktreeLaneStatus
  /** The line's brief state (drift vocabulary; `settled` once terminal). */
  readonly state: CbeLineState
  /** The user-declared parent line, or null for a root branch. */
  readonly parentLineId: string | null
  readonly firstSeen: string
  readonly lastSeen: string
  readonly eventCount: number
  readonly drift: number
  /** The adjudication timestamp (`knowledge.idea.failed`); null while open/adopted-without-event. */
  readonly closedAt: string | null
  /** The wiki record's `failureReason` — the documented No's own words. */
  readonly closeReason: string | null
  /** Failed lanes: days from the lane's last touch to its close (the GUT number). */
  readonly gutDays: number | null
  /** Open lanes: days since the lane's last touch to `now`. */
  readonly idleDays: number | null
  /** The lane's work nodes (timestamped touches), ts ascending — the beads. */
  readonly touches: readonly CbeWorktreeTouch[]
}

/** One mainline declaration (one ref move in the reflog). */
export interface CbeMainlineDeclaration {
  readonly lineId: string
  readonly declaredAt: string
  readonly eventId: string
}

/** The whole derived worktree (L1: re-derivable, never persisted). */
export interface CbeWorktree {
  readonly asOf: string
  /** Mainline lane first, then open, then adopted, then failed (newest activity first). */
  readonly lanes: readonly CbeWorktreeLane[]
  readonly mainline: CbeMainlineDeclaration | null
  /** Every declaration in order — the mainline reflog (the 大改变 record). */
  readonly mainlineHistory: readonly CbeMainlineDeclaration[]
  readonly counts: {
    readonly open: number
    readonly failed: number
    readonly adopted: number
  }
}


/** Round to 3 decimals for stable rendering/serialization. */
function r3(value: number): number {
  return Math.round(value * 1000) / 1000
}


/**
 * The user-declared parent edges, last declaration per child (a re-declared
 * edge moves the branch; a `parentIdeaId: null` payload clears it). Source
 * of truth for BOTH the derivation and the service's cycle guard, so the
 * two can never disagree.
 * @param events - ledger events, any order.
 * @returns child idea id → parent idea id.
 */
export function ideaParentEdges(events: readonly EventRecord[]): ReadonlyMap<string, string> {
  const edges = new Map<string, string>()
  const ordered = orderedEvents(events)
  for (const event of ordered) {
    if (event.action !== IDEA_PARENT_ACTION || event.refs.ideaId === undefined) continue
    const parent = event.payload['parentIdeaId']
    if (typeof parent === 'string') edges.set(event.refs.ideaId, parent)
    else edges.delete(event.refs.ideaId)
  }
  return edges
}

/** The mainline declarations in order (the reflog); malformed events skip. */
function mainlineDeclarations(events: readonly EventRecord[]): CbeMainlineDeclaration[] {
  const declarations: CbeMainlineDeclaration[] = []
  const ordered = orderedEvents(events)
  for (const event of ordered) {
    if (event.action !== MAINLINE_ACTION) continue
    const ideaId = event.refs.ideaId
    const projectId = event.refs.projectId
    const lineId = ideaId !== undefined ? ideaId : projectId !== undefined ? `project:${projectId}` : null
    if (lineId === null) continue
    declarations.push(Object.freeze({ lineId, declaredAt: event.ts, eventId: event.id }))
  }
  return declarations
}

/**
 * Derive the whole worktree over full history: lanes from the same line
 * attribution the brief uses (idea lines plus `project:<id>` lines), status
 * from the wiki's idea records (the state the events trail), parent edges
 * from user declarations only, and the mainline ref from its reflog.
 * Wiki ideas with no ledger events still appear as zero-event lanes — a
 * branch exists once the surveyor draws it, not once work lands on it.
 * @param events - ledger events, any order.
 * @param wiki - the wiki tables the labels and idea statuses come from.
 * @param nowMs - "now" in epoch ms (injectable for determinism).
 * @returns the frozen worktree model.
 */
export function deriveWorktree(
  events: readonly EventRecord[],
  wiki: CbeWikiSnapshot,
  nowMs: number,
): CbeWorktree {
  const window = {
    since: '1970-01-01T00:00:00.000Z',
    until: new Date(nowMs).toISOString(),
    projectId: null,
  }
  const lines = deriveLines(events, wiki, window, nowMs)
  const lineById = new Map(lines.map(line => [line.id, line]))

  const ideaById = new Map(wiki.ideas.map(idea => [idea.id, idea]))
  const edges = ideaParentEdges(events)
  const declarations = mainlineDeclarations(events)
  const mainline = declarations.length === 0 ? null : declarations[declarations.length - 1] ?? null

  // First failure event per idea: the close timestamp (the record is the
  // state, the event is the trail — the timestamp comes from the trail).
  const ordered = orderedEvents(events)
  const failedAtMs = new Map<string, { ms: number; ts: string }>()
  for (const event of ordered) {
    if (event.action !== 'knowledge.idea.failed' || event.refs.ideaId === undefined) continue
    if (failedAtMs.has(event.refs.ideaId)) continue
    const ms = tsToMs(event.ts)
    if (ms !== null) failedAtMs.set(event.refs.ideaId, { ms, ts: event.ts })
  }

  const statusOf = (lineId: string): CbeWorktreeLaneStatus => {
    const idea = ideaById.get(lineId)
    if (idea === undefined) return 'open' // project lanes (and unknown ids) never close in v1
    return idea.status === 'failed' ? 'failed' : idea.status === 'adopted' ? 'adopted' : 'open'
  }

  const lanes: CbeWorktreeLane[] = []

  // Lanes with ledger presence (idea lines + project lines).
  for (const line of lines) {
    const status = statusOf(line.id)
    const lastMs = tsToMs(line.lastSeen)
    const close = failedAtMs.get(line.id)
    // GUT: days from the lane's last touch before the close to the close.
    let gutDays: number | null = null
    if (status === 'failed' && close !== undefined) {
      let lastTouchMs: number | null = null
      for (const event of ordered) {
        if (event.refs.ideaId !== line.id) continue
        const ms = tsToMs(event.ts)
        if (ms === null || ms >= close.ms) continue
        if (lastTouchMs === null || ms > lastTouchMs) lastTouchMs = ms
      }
      if (lastTouchMs !== null) gutDays = r3((close.ms - lastTouchMs) / MS_PER_DAY)
    }
    const idleDays = status === 'open' && lastMs !== null
      ? r3(Math.max(0, (nowMs - lastMs) / MS_PER_DAY))
      : null
    const touches: CbeWorktreeTouch[] = []
    for (const event of ordered) {
      const eventLine = event.refs.ideaId !== undefined
        ? event.refs.ideaId
        : event.refs.projectId !== undefined ? `project:${event.refs.projectId}` : null
      if (eventLine !== line.id) continue
      touches.push(Object.freeze({ at: event.ts, kind: touchKindOf(event), action: event.action }))
    }
    lanes.push(Object.freeze({
      lineId: line.id,
      label: line.label,
      status,
      state: line.state,
      parentLineId: edges.get(line.id) ?? null,
      firstSeen: line.firstSeen,
      lastSeen: line.lastSeen,
      eventCount: line.eventCount,
      drift: line.drift,
      closedAt: status === 'failed' ? (close?.ts ?? null) : null,
      closeReason: ideaById.get(line.id)?.failureReason ?? null,
      gutDays,
      idleDays,
      touches: Object.freeze(touches),
    }))
  }

  // Wiki-only ideas: real branches with no commits yet.
  for (const idea of wiki.ideas) {
    if (lineById.has(idea.id)) continue
    const status = statusOf(idea.id)
    lanes.push(Object.freeze({
      lineId: idea.id,
      label: idea.title,
      status,
      state: status === 'open' ? 'exploring' : 'settled',
      parentLineId: edges.get(idea.id) ?? null,
      firstSeen: idea.createdAt,
      lastSeen: idea.createdAt,
      eventCount: 0,
      drift: 0,
      closedAt: null,
      closeReason: idea.failureReason ?? null,
      gutDays: null,
      idleDays: status === 'open' ? r3(Math.max(0, (nowMs - (tsToMs(idea.createdAt) ?? nowMs)) / MS_PER_DAY)) : null,
      touches: Object.freeze([]),
    }))
  }

  const rank = (lane: CbeWorktreeLane): number =>
    mainline !== null && lane.lineId === mainline.lineId ? 0
    : lane.status === 'open' ? 1
    : lane.status === 'adopted' ? 2
    : 3
  const activityMs = (lane: CbeWorktreeLane): number => tsToMs(lane.closedAt ?? lane.lastSeen) ?? 0
  lanes.sort((a, b) => rank(a) - rank(b) || activityMs(b) - activityMs(a) || a.lineId.localeCompare(b.lineId))

  return Object.freeze({
    asOf: new Date(nowMs).toISOString(),
    lanes: Object.freeze(lanes),
    mainline,
    mainlineHistory: Object.freeze(declarations),
    counts: Object.freeze({
      open: lanes.filter(lane => lane.status === 'open').length,
      failed: lanes.filter(lane => lane.status === 'failed').length,
      adopted: lanes.filter(lane => lane.status === 'adopted').length,
    }),
  })
}
