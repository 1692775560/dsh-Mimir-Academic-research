/**
 * Ledger domain module: the Remote-facing verbs over the append-only growth
 * record — the event query and the progress-report render. The domain logic
 * (event persistence, filtering, report assembly) lives in `../ledger.ts`;
 * this module adds the runtime guards and the `ResearchResult` union shape,
 * matching the other modules under `./services`.
 * @module dsh-mimir/src/services/ledger
 */

import type { ResearchWikiDomain } from '../store.ts'
import {
  appendEvent,
  buildProgressReport,
  countEvents,
  emitEvent,
  EVENT_PAYLOAD_MAX_CHARS,
  isObservationEvent,
  JOURNAL_TEXT_MAX_CHARS,
  LIST_EVENTS_MAX_LIMIT,
  listEvents,
  PANEL_ACTOR,
} from '../ledger.ts'
import { deriveBrief, JOURNAL_ACTION, QUESTION_ANSWERED_ACTION, QUESTION_SHOWED_ACTION, renderBriefMarkdown, CBE_DERIVATION_VERSION } from '../cognitive-map.ts'
import { MS_PER_DAY } from '../time.ts'
import type { CbeBriefWindow, CbeWikiSnapshot } from '../cognitive-map.ts'
import { evidenceModelAt, evidenceProfileOf } from '../cbe-engine.ts'
import { deriveForaging } from '../foraging.ts'
import { deriveLibraryThemes } from '../library-themes.ts'
import { deriveHabits } from '../habits.ts'
import { renderJournalDraft } from '../journal-draft.ts'
import type { JournalDraftKind } from '../journal-draft.ts'
import {
  deriveWorktree,
  ideaParentEdges,
  IDEA_CLOSE_REASON_MAX_CHARS,
  IDEA_PARENT_ACTION,
  MAINLINE_ACTION,
} from '../worktree.ts'
import type {
  CbeMainlineDeclaration,
  CbeWorktreeLane,
} from '../worktree.ts'
import { CBE_EUREKA_WINDOW_DAYS, EUREKA_ACTION, eurekaContextAt, eurekaModelAt, eurekaProfileOf } from '../eureka.ts'
import { MOMENT_PIN_ACTION, deriveCuratedMoments } from '../moment-index.ts'
import { CBE_MOMENT_RETURN_GAP_DAYS } from '../moment-candidates.ts'
import { assembleDigest } from '../report-tier.ts'
import type { CbeDigestTier } from '../report-tier.ts'
import { renderDigest } from '../render-digest.ts'
import type {
  EventRecord,
  EventRefs,
  LedgerActorKind,
  ResearchEventFilter,
  ResearchAddJournalEntryResult,
  ResearchBriefQuestion,
  ResearchCloseIdeaResult,
  ResearchAdoptIdeaResult,
  ResearchGenerateBriefOptions,
  ResearchGenerateBriefResult,
  ResearchGenerateJournalDraftResult,
  ResearchGetEvidenceProfileResult,
  ResearchGetForagingResult,
  ResearchGetHabitsResult,
  ResearchGetLibraryThemesResult,
  ResearchGetWorktreeResult,
  ResearchGetMomentIndexResult,
  ResearchGetEurekaViewResult,
  ResearchMomentIndexView,
  ResearchMomentView,
  ResearchEurekaView,
  ResearchListEventsResult,
  ResearchProgressReportOptions,
  ResearchProgressReportResult,
  ResearchSetIdeaParentResult,
  ResearchSetMainlineResult,
  ResearchWorktreeMainlineView,
  ResearchWorktreeView,
  ResearchSetEurekaResult,
  ResearchPinMomentResult,
  ResearchGenerateDigestResult,
  ResearchGenerateDigestOptions,
} from '../types.ts'
import type { CbeWindowFeatures } from '../window-features.ts'
import { rejected, success } from './common.ts'

/** Everything the ledger domain functions need from the service scope. */
export interface LedgerDeps {
  /** Open research-wiki domain (the ledger's events table lives here). */
  readonly domain: ResearchWikiDomain
}

/** The default comparison span every window-bounded organ falls back to. */
const DEFAULT_SPAN_DAYS = 30


/**
 * Snapshot the wiki tables the cognitive layer reads. The library is
 * deliberately NOT part of this snapshot: the shelf is not a line, carries
 * no drift, and is read directly by {@link module:dsh-mimir/src/library-themes}.
 */
function wikiSnapshot(domain: ResearchWikiDomain): CbeWikiSnapshot {
  return {
    ideas: [...domain.table('ideas').entries()].map(([, record]) => record),
    claims: [...domain.table('claims').entries()].map(([, record]) => record),
    projects: [...domain.table('projects').entries()].map(([, record]) => record),
  }
}

/**
 * Resolve one window's bounds: an explicit `since` wins, otherwise the
 * caller's span (or {@link DEFAULT_SPAN_DAYS}) is counted back from `until`
 * — so an unbounded call compares like with like instead of against all of
 * history.
 */
function resolveWindow(
  since: string | undefined,
  until: string | undefined,
  spanDays: number,
): { readonly since: string; readonly until: string } {
  const untilIso = until ?? new Date().toISOString()
  if (since !== undefined) return { since, until: untilIso }
  const parsed = Date.parse(untilIso)
  const anchor = Number.isNaN(parsed) ? Date.now() : parsed
  return { since: new Date(anchor - spanDays * MS_PER_DAY).toISOString(), until: untilIso }
}

/** One bounded ledger read: what was folded, and what was really there. */
interface LedgerWindow {
  /** The events handed to the fold — the newest window, time-ascending, observations out. */
  readonly events: readonly EventRecord[]
  /** Every event matching the filter, uncapped by {@link LIST_EVENTS_MAX_LIMIT}. */
  readonly total: number
  /** Whether the fold saw less than the whole match set. */
  readonly truncated: boolean
}

/**
 * Read one bounded ledger window for a pure CBE fold. Three guards that the
 * bare `listEvents` call used to leave open:
 *
 * - **Newest window, not oldest.** `listEvents` caps at
 *   {@link LIST_EVENTS_MAX_LIMIT}; keeping the head of history froze every
 *   organ on the first events ever written, silently and forever.
 * - **Observation events stripped.** The read path writes
 *   `cbe.question.showed` / `.answered` about itself; counting them let
 *   repeatedly opening the panel inflate the window mass and lift a line's
 *   I2 evidence tier with no research behind it.
 * - **The real total reported.** `events.length` is the capped window, not
 *   the ledger — callers must not dress the cap up as the total.
 *
 * @param domain - open wiki domain.
 * @param filter - the same predicates `listEvents` takes.
 * @param label - what is folding, for the truncation warning.
 */
async function loadLedgerWindow(
  domain: ResearchWikiDomain,
  filter: Omit<ResearchEventFilter, 'limit' | 'order' | 'anchor'>,
  label: string,
): Promise<LedgerWindow> {
  const [events, total] = await Promise.all([
    listEvents(domain, { ...filter, limit: LIST_EVENTS_MAX_LIMIT }),
    countEvents(domain, filter),
  ])
  const research = events.filter(event => !isObservationEvent(event))
  const truncated = total > LIST_EVENTS_MAX_LIMIT
  if (truncated) {
    console.warn(
      `[mimir] ledger window truncated: ${label} folded ${research.length} of ${total} events (cap ${LIST_EVENTS_MAX_LIMIT})`,
    )
  }
  return { events: research, total, truncated }
}

/**
 * Query the research ledger (the append-only growth record). Every field is
 * an optional filter: a project ref, an actor kind, an action prefix
 * (e.g. `compute.`), and ISO-8601 time bounds (`since` inclusive, `until`
 * exclusive). The result is capped (default 200, hard cap 1000) and ordered
 * by (ts, id); `order: 'desc'` inverts it. The cap keeps the NEWEST matches
 * (`anchor: 'oldest'` is the explicit exception), so a ledger past the cap
 * still returns live activity. An illegal limit, anchor, or bound, or an
 * unparseable one, is `invalid-input` — the ledger itself is never mutated
 * by this read.
 * @param deps - open wiki domain.
 * @param request - the optional filters.
 * @returns the matching events.
 */
export async function listEventsRemote(
  deps: LedgerDeps,
  request: {
    projectId?: string | undefined
    actorKind?: string | undefined
    actionPrefix?: string | undefined
    since?: string | undefined
    until?: string | undefined
    limit?: number | undefined
    order?: string | undefined
    anchor?: string | undefined
  },
): Promise<ResearchListEventsResult> {
  const kind = request.actorKind
  if (kind !== undefined && !(['user', 'agent', 'subagent', 'module', 'system'] as readonly string[]).includes(kind)) {
    return rejected({ code: 'invalid-input', message: `unknown actorKind: ${kind}` })
  }
  const order = request.order
  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    return rejected({ code: 'invalid-input', message: `order must be 'asc' or 'desc', got '${order}'` })
  }
  const anchor = request.anchor
  if (anchor !== undefined && anchor !== 'newest' && anchor !== 'oldest') {
    return rejected({ code: 'invalid-input', message: `anchor must be 'newest' or 'oldest', got '${anchor}'` })
  }
  try {
    const events = await listEvents(deps.domain, {
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      ...(kind === undefined ? {} : { actorKind: kind as LedgerActorKind }),
      ...(request.actionPrefix === undefined ? {} : { actionPrefix: request.actionPrefix }),
      ...(request.since === undefined ? {} : { since: request.since }),
      ...(request.until === undefined ? {} : { until: request.until }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(order === undefined ? {} : { order }),
      ...(anchor === undefined ? {} : { anchor }),
    })
    return success({ events })
  } catch (error) {
    return rejected({
      code: 'invalid-input',
      message: error instanceof RangeError ? error.message : 'event filter is invalid',
    })
  }
}

/**
 * Render the research PROGRESS report (the transparent growth record) over
 * the ledger plus current wiki state: a TL;DR line, the full progress of the
 * window, the learning & judgment changes (claim transitions, idea failures
 * with reasons, review verdicts), the current state counts, the claim ledger
 * with each claim's last ledgered change, experiments & runs, and the
 * destructive-operations ledger as the closing risk footnote. A project id
 * scopes everything to that project (`project-not-found` for an unknown
 * id); time bounds are ISO-8601 (`since` inclusive, `until` exclusive) — a
 * recent window (e.g. 7 days) produces the weekly 组会 digest. The report is
 * a pure query — it writes nothing.
 * @param deps - open wiki domain.
 * @param request - the optional scope and bounds.
 * @returns the Markdown report plus the event count it covered.
 */
export async function generateProgressReportRemote(
  deps: LedgerDeps,
  request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  },
): Promise<ResearchProgressReportResult> {
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const options: ResearchProgressReportOptions = {
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.since === undefined ? {} : { since: request.since }),
    ...(request.until === undefined ? {} : { until: request.until }),
  }
  try {
    const [markdown, events] = await Promise.all([
      buildProgressReport(deps.domain, options),
      listEvents(deps.domain, {
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.since === undefined ? {} : { since: options.since }),
        ...(options.until === undefined ? {} : { until: options.until }),
        limit: LIST_EVENTS_MAX_LIMIT,
      }),
    ])
    return success({ markdown, generatedAt: new Date().toISOString(), eventCount: events.length })
  } catch (error) {
    return rejected({
      code: 'invalid-input',
      message: error instanceof RangeError ? error.message : 'report options are invalid',
    })
  }
}

/**
 * Render the COGNITIVE BRIEF (the DDM-lite roadbook) of one window: the
 * lines' drift states, the eureka candidates, the status transitions, the
 * open loops, the boundary questions — and, between the loops and the
 * questions, the user's own L2 journal lines. The boundary questions also
 * travel as structured, label-resolved rows ({@link ResearchBriefQuestion})
 * so the view can render them as interactive confirmation cards. Omitted
 * bounds open into the full history (`since` = epoch, `until` = now); an
 * unknown project id is `project-not-found`; an unparseable bound is
 * `invalid-input`. The brief is a pure query — it writes nothing (the L2
 * write path is {@link addJournalEntryRemote}).
 * @param deps - open wiki domain.
 * @param request - the optional scope and bounds.
 * @returns the Markdown brief, its interactive questions, and the event count.
 */
export async function generateBriefRemote(
  deps: LedgerDeps,
  request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  },
): Promise<ResearchGenerateBriefResult> {
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const options: ResearchGenerateBriefOptions = {
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.since === undefined ? {} : { since: request.since }),
    ...(request.until === undefined ? {} : { until: request.until }),
  }
  const window: CbeBriefWindow = {
    since: options.since ?? new Date(0).toISOString(),
    until: options.until ?? new Date().toISOString(),
    projectId: options.projectId ?? null,
  }
  try {
    const { events } = await loadLedgerWindow(deps.domain, {
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.until === undefined ? {} : { until: options.until }),
    }, 'brief')
    const wiki = wikiSnapshot(deps.domain)
    const brief = deriveBrief(events, wiki, window, Date.now())
    const questions = briefQuestions(brief, wiki)
    // I4 instrumentation: the map records that it asked — the meta event is
    // zero-weight (never in LINE_WEIGHTS) and best-effort, so the pure
    // query's contract only gains an observation line, never a failure.
    if (questions.length > 0) {
      await emitEvent(deps.domain, {
        actor: PANEL_ACTOR,
        action: QUESTION_SHOWED_ACTION,
        payload: { count: questions.length, lineIds: questions.map(question => question.lineId) },
      })
    }
    return success({
      markdown: renderBriefMarkdown(brief),
      generatedAt: new Date().toISOString(),
      eventCount: events.length,
      derivationVersion: CBE_DERIVATION_VERSION,
      questions,
    })
  } catch (error) {
    return rejected({
      code: 'invalid-input',
      message: error instanceof RangeError ? error.message : 'brief options are invalid',
    })
  }
}

/**
 * Validate one self-reported mood rating (1–5 integer): returns a one-key
 * payload spread, or throws a RangeError naming the field. Self-report
 * ONLY — the service never estimates these for the user.
 */
function moodRating(value: number | undefined, name: string): Record<string, number> {
  if (value === undefined) return {}
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new RangeError(`${name} must be an integer between 1 and 5`)
  }
  return { [name]: value }
}

/**
 * Label-resolve the brief's boundary questions for the view: idea/project
 * ids become titles (the local landmark names), a pending claim becomes a
 * 48-char excerpt of its own text. Unresolvable ids pass through verbatim —
 * the card still names a line, never a blank.
 */
function briefQuestions(brief: ReturnType<typeof deriveBrief>, wiki: CbeWikiSnapshot): readonly ResearchBriefQuestion[] {
  const labels = new Map<string, string>([
    ...wiki.ideas.map(idea => [idea.id, idea.title] as const),
    ...wiki.projects.map(project => [`project:${project.id}`, project.title] as const),
    ...wiki.claims.map(claim => [claim.id, claim.text.length > 48 ? `${claim.text.slice(0, 47)}…` : claim.text] as const),
  ])
  return Object.freeze(brief.questions.map(question => Object.freeze({
    kind: question.kind,
    lineId: question.lineId,
    label: labels.get(question.lineId) ?? question.lineId,
  })))
}

/**
 * Append one L2 journal entry (the user's own words) to the ledger: the only
 * write path the cognitive map reads as narrative. The text must be a
 * non-blank string capped at {@link JOURNAL_TEXT_MAX_CHARS} characters; a
 * `projectId` scopes the entry (unknown id → `project-not-found`), an
 * `ideaId` writes it against one line — both refs are omitted when absent.
 * Optional `valence`/`arousal` self-report ratings (1–5 integers) ride the
 * payload verbatim. The stored event is the single source of truth: L2 is
 * re-derived, never persisted as a table of its own.
 * @param deps - open wiki domain.
 * @param request - the text plus optional project/line refs.
 * @returns the stored journal event.
 */
export async function addJournalEntryRemote(
  deps: LedgerDeps,
  request: {
    text: string
    projectId?: string | undefined
    ideaId?: string | undefined
    valence?: number | undefined
    arousal?: number | undefined
    /** When the entry answers a boundary-question card, the I4 meta event rides along. */
    question?: { kind: string; lineId: string } | undefined
  },
): Promise<ResearchAddJournalEntryResult> {
  if (typeof request.text !== 'string' || request.text.trim() === '') {
    return rejected({ code: 'invalid-input', message: 'journal text must not be empty' })
  }
  if (request.text.length > JOURNAL_TEXT_MAX_CHARS) {
    return rejected({
      code: 'invalid-input',
      message: `journal text is capped at ${JOURNAL_TEXT_MAX_CHARS} characters`,
    })
  }
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  if (request.question !== undefined) {
    const kind = request.question.kind
    const lineId = request.question.lineId
    if ((kind !== 'returning-branch' && kind !== 'pending-claim')
      || typeof lineId !== 'string' || lineId === '') {
      return rejected({
        code: 'invalid-input',
        message: 'question must be { kind: returning-branch | pending-claim, lineId }',
      })
    }
  }
  const refs: EventRefs = {
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.ideaId === undefined ? {} : { ideaId: request.ideaId }),
  }
  try {
    const event = await appendEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: JOURNAL_ACTION,
      ...(Object.keys(refs).length === 0 ? {} : { refs }),
      payload: {
        text: request.text,
        ...moodRating(request.valence, 'valence'),
        ...moodRating(request.arousal, 'arousal'),
      },
    })
    // I4 instrumentation: an answer to a boundary-question card is itself
    // recorded — the G3 natural experiment (shown vs never-shown) reads
    // these lines. Best-effort, zero-weight, never part of the journal.
    if (request.question !== undefined) {
      const lineId = request.question.lineId
      const answeredRefs: EventRefs = lineId.startsWith('project:')
        ? { projectId: lineId.slice('project:'.length) }
        : deps.domain.table('ideas').get(lineId) !== undefined ? { ideaId: lineId }
        : deps.domain.table('claims').get(lineId) !== undefined ? { claimId: lineId }
        : {}
      await emitEvent(deps.domain, {
        actor: PANEL_ACTOR,
        action: QUESTION_ANSWERED_ACTION,
        ...(Object.keys(answeredRefs).length === 0 ? {} : { refs: answeredRefs }),
        payload: { kind: request.question.kind, lineId },
      })
    }
    return success({ event })
  } catch (error) {
    return rejected({
      code: 'invalid-input',
      message: error instanceof RangeError ? error.message : 'journal entry is invalid',
    })
  }
}

/* ------------------------------------------------------------------------ *
 * Evidence engine (S3): the learned profile — read-only instrumentation.
 * ------------------------------------------------------------------------ */

/**
 * Read the learned evidence profile (E1 instrumentation): the κ-shrunk
 * effective value of every ledger action, folded over the full ledger by
 * the pure engine (`evidenceModelAt`). READ-ONLY and deliberately NOT
 * consumed by any UI until G1 passes — the profile exists so the
 * priors-versus-learned comparison is inspectable when that day comes.
 * The profile must never be used as a self-optimization performance
 * metric: its job is honest priors, not leaderboard copy.
 * @param deps - open wiki domain.
 * @returns the folded profile (rows sorted by effective value).
 */
export async function getEvidenceProfileRemote(deps: LedgerDeps): Promise<ResearchGetEvidenceProfileResult> {
  try {
    const { events } = await loadLedgerWindow(deps.domain, {}, 'evidence profile')
    const model = evidenceModelAt(events)
    const profile = evidenceProfileOf(model)
    return success({
      profile: {
        derivationVersion: profile.derivation.version,
        terminalsFolded: profile.derivation.terminalsFolded,
        actions: profile.actions,
      },
    })
  } catch (error) {
    console.warn('[mimir]', 'the evidence profile could not be folded', error)
    return rejected({ code: 'operation-failed', message: 'the evidence profile could not be folded' })
  }
}

/**
 * Read the foraging layer (S4): the territory ledger (one E0 row per
 * declared project — events, attention mass, harvest-proxy counts, day
 * gaps), the personal GUT baseline (silent below its floor), and the GUT
 * cards' data — two numbers, zero verbs, no go/stay language. A pure
 * query over the full ledger plus current wiki state; it writes nothing.
 * @param deps - open wiki domain.
 * @returns the derived, label-resolved foraging layer.
 */
export async function getForagingRemote(deps: LedgerDeps): Promise<ResearchGetForagingResult> {
  try {
    const { events } = await loadLedgerWindow(deps.domain, {}, 'foraging')
    const wiki = wikiSnapshot(deps.domain)
    const layer = deriveForaging(events, wiki, Date.now())
    return success({
      foraging: {
        derivedAt: layer.asOf,
        territories: layer.territories,
        baseline: layer.baseline,
        cards: layer.cards,
      },
    })
  } catch (error) {
    console.warn('[mimir]', 'the foraging layer could not be derived', error)
    return rejected({ code: 'operation-failed', message: 'the foraging layer could not be derived' })
  }
}

/* ------------------------------------------------------------------------ *
 * Worktree (S2): the research process as a git-like working tree. The view
 * is a pure L0 projection (E0 by construction); the three writes are the
 * user's own structural declarations — the mainline ref move, the declared
 * derivation edge, and the documented No — every one an explicit,
 * user-refusable action, so origin attribution is 'user' by construction.
 * ------------------------------------------------------------------------ */

/**
 * The label map every worktree view resolves against: idea ids and
 * `project:<id>` lanes become their wiki titles; unresolvable ids pass
 * through verbatim (the view still names a line, never a blank).
 */
function worktreeLabels(wiki: CbeWikiSnapshot): Map<string, string> {
  return new Map<string, string>([
    ...wiki.ideas.map(idea => [idea.id, idea.title] as const),
    ...wiki.projects.map(project => [`project:${project.id}`, project.title] as const),
  ])
}

/** One declaration joined with its label for the view. */
function declaredView(
  declaration: CbeMainlineDeclaration,
  labels: ReadonlyMap<string, string>,
): ResearchWorktreeMainlineView {
  return Object.freeze({
    lineId: declaration.lineId,
    label: labels.get(declaration.lineId) ?? declaration.lineId,
    declaredAt: declaration.declaredAt,
  })
}

/**
 * Read the whole derived worktree: every lane (idea lines plus project
 * lines, including wiki-only ideas with no events yet) with its status,
 * declared parent, activity dates, and documented-No numbers; the mainline
 * ref and its full reflog; and the lane counts. A pure query over the full
 * ledger plus current wiki state — it writes nothing, infers no genealogy,
 * and needs no gate (the view is the data wearing tree semantics).
 * @param deps - open wiki domain.
 * @returns the derived, label-resolved worktree.
 */
export async function getWorktreeRemote(deps: LedgerDeps): Promise<ResearchGetWorktreeResult> {
  try {
    const { events } = await loadLedgerWindow(deps.domain, {}, 'worktree')
    const wiki = wikiSnapshot(deps.domain)
    const tree = deriveWorktree(events, wiki, Date.now())
    const labels = worktreeLabels(wiki)
    const lanes = tree.lanes.map((lane: CbeWorktreeLane) => Object.freeze({
      ...lane,
      parentLabel: lane.parentLineId === null
        ? null
        : labels.get(lane.parentLineId) ?? lane.parentLineId,
    }))
    const view: ResearchWorktreeView = Object.freeze({
      derivedAt: tree.asOf,
      lanes: Object.freeze(lanes),
      mainline: tree.mainline === null ? null : declaredView(tree.mainline, labels),
      mainlineHistory: Object.freeze(tree.mainlineHistory.map(item => declaredView(item, labels))),
      counts: Object.freeze({ ...tree.counts }),
    })
    return success({ worktree: view })
  } catch (error) {
    console.warn('[mimir]', 'the worktree could not be derived', error)
    return rejected({ code: 'operation-failed', message: 'the worktree could not be derived' })
  }
}

/**
 * Move the mainline ref (one `cbe.mainline.set` event): the user's explicit
 * declaration of the current mainline — the system never moves it and never
 * ranks lines into it. Exactly one of `ideaId`/`projectId` (unknown ids and
 * non-active ideas are `invalid-input` — the mainline is a live direction).
 * The reflog is the event history itself: 大改变 stays on the record.
 * @param deps - open wiki domain.
 * @param request - the line to declare (exactly one ref kind).
 * @returns the stored declaration event.
 */
export async function setMainlineRemote(
  deps: LedgerDeps,
  request: {
    ideaId?: string | undefined
    projectId?: string | undefined
  },
): Promise<ResearchSetMainlineResult> {
  const { ideaId, projectId } = request
  if ((ideaId === undefined) === (projectId === undefined)) {
    return rejected({
      code: 'invalid-input',
      message: 'setMainline takes exactly one of ideaId or projectId',
    })
  }
  if (ideaId !== undefined) {
    const idea = deps.domain.table('ideas').get(ideaId)
    if (idea === undefined) {
      return rejected({ code: 'invalid-input', message: `unknown ideaId: ${ideaId}` })
    }
    if (idea.status !== 'active') {
      return rejected({
        code: 'invalid-input',
        message: `only an active line can be the mainline (this one is ${idea.status})`,
      })
    }
  } else if (projectId !== undefined && deps.domain.table('projects').get(projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId })
  }
  try {
    const event = await appendEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: MAINLINE_ACTION,
      refs: ideaId !== undefined ? { ideaId } : { projectId: projectId as string },
    })
    return success({ event })
  } catch (error) {
    console.warn('[mimir]', 'the mainline declaration could not be written', error)
    return rejected({ code: 'operation-failed', message: 'the mainline declaration could not be written' })
  }
}

/**
 * Declare (or clear) one derivation edge — a branch point, in the
 * surveyor's own words: `refs.ideaId` carries the child, the payload the
 * parent. `parentIdeaId: null` clears the edge (an append, never a rewrite
 * — the history of re-declarations stays on the record). Edges are NEVER
 * inferred; the cycle guard walks the existing declared edges so the
 * genealogy stays a forest.
 * @param deps - open wiki domain.
 * @param request - the child idea plus its parent (or null to clear).
 * @returns the stored edge event.
 */
export async function setIdeaParentRemote(
  deps: LedgerDeps,
  request: {
    ideaId: string
    parentIdeaId: string | null
  },
): Promise<ResearchSetIdeaParentResult> {
  const { ideaId, parentIdeaId } = request
  if (typeof ideaId !== 'string' || ideaId === '') {
    return rejected({ code: 'invalid-input', message: 'ideaId must be a non-empty string' })
  }
  if (deps.domain.table('ideas').get(ideaId) === undefined) {
    return rejected({ code: 'invalid-input', message: `unknown ideaId: ${ideaId}` })
  }
  if (parentIdeaId === null) {
    try {
      const event = await appendEvent(deps.domain, {
        actor: PANEL_ACTOR,
        action: IDEA_PARENT_ACTION,
        refs: { ideaId },
        payload: { parentIdeaId: null },
      })
      return success({ event })
    } catch (error) {
      console.warn('[mimir]', 'the derivation edge could not be written', error)
      return rejected({ code: 'operation-failed', message: 'the derivation edge could not be written' })
    }
  }
  if (deps.domain.table('ideas').get(parentIdeaId) === undefined) {
    return rejected({ code: 'invalid-input', message: `unknown parentIdeaId: ${parentIdeaId}` })
  }
  if (parentIdeaId === ideaId) {
    return rejected({ code: 'invalid-input', message: 'a line cannot derive from itself' })
  }
  // The cycle guard: walk the DECLARED edges up from the proposed parent;
  // meeting the child again would close a loop the map must never carry.
  const edges = ideaParentEdges(await listEvents(deps.domain, {
    actionPrefix: 'cbe.idea.',
    limit: LIST_EVENTS_MAX_LIMIT,
  }))
  let cursor: string | undefined = edges.get(parentIdeaId)
  for (let hops = 0; cursor !== undefined && hops < 1000; hops += 1) {
    if (cursor === ideaId) {
      return rejected({ code: 'invalid-input', message: 'that derivation would create a cycle' })
    }
    cursor = edges.get(cursor)
  }
  try {
    const event = await appendEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: IDEA_PARENT_ACTION,
      refs: { ideaId },
      payload: { parentIdeaId },
    })
    return success({ event })
  } catch (error) {
    console.warn('[mimir]', 'the derivation edge could not be written', error)
    return rejected({ code: 'operation-failed', message: 'the derivation edge could not be written' })
  }
}

/**
 * Close one idea line as a dead end — a documented No: the wiki record
 * flips to `failed` with the reason, and one `knowledge.idea.failed` event
 * lands in the ledger under the PANEL actor (an explicit, user-refusable
 * action, so origin attribution is 'user' by construction — whoever bears
 * the uncertainty of the No owns it). The reason is required and capped at
 * {@link IDEA_CLOSE_REASON_MAX_CHARS} characters; only an active line can
 * be closed (an adopted line is a merge, not a dead end). Dead ends are
 * never pruned — every ✗ stays on the tree with its reason and its GUT
 * number.
 * @param deps - open wiki domain.
 * @param request - the idea plus its one-line lesson.
 * @returns the stored close event.
 */
export async function closeIdeaRemote(
  deps: LedgerDeps,
  request: {
    ideaId: string
    reason: string
  },
): Promise<ResearchCloseIdeaResult> {
  const { ideaId, reason } = request
  if (typeof reason !== 'string' || reason.trim() === '') {
    return rejected({ code: 'invalid-input', message: 'close reason must not be empty' })
  }
  if (reason.length > IDEA_CLOSE_REASON_MAX_CHARS) {
    return rejected({
      code: 'invalid-input',
      message: `close reason is capped at ${IDEA_CLOSE_REASON_MAX_CHARS} characters`,
    })
  }
  const idea = deps.domain.table('ideas').get(ideaId)
  if (idea === undefined) {
    return rejected({ code: 'invalid-input', message: `unknown ideaId: ${ideaId}` })
  }
  if (idea.status === 'failed') {
    return rejected({ code: 'invalid-input', message: 'that line is already closed (a documented No)' })
  }
  if (idea.status === 'adopted') {
    return rejected({ code: 'invalid-input', message: 'an adopted line is a merge, not a dead end' })
  }
  try {
    await deps.domain.table('ideas').update(ideaId, current => ({
      ...current,
      status: 'failed' as const,
      failureReason: reason,
    }))
    const event = await appendEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'knowledge.idea.failed',
      refs: { ideaId },
      payload: { reason },
    })
    return success({ event })
  } catch (error) {
    console.warn('[mimir]', 'the close could not be written', error)
    return rejected({ code: 'operation-failed', message: 'the close could not be written' })
  }
}

/**
 * Adopt one idea line — declare the merge: the wiki record flips to
 * `adopted` and one `knowledge.idea.adopted` event lands in the ledger
 * under the PANEL actor (an explicit, user-refusable action; origin rule
 * holds — whoever bears the uncertainty of the Yes owns it). Only an
 * active line can be merged: a documented No is a dead end, not a merge,
 * and a merge is written once. The merge is the positive terminal —
 * symmetric weight of the close (+2.5 vs −2.5) and a +1 outcome for the
 * evidence engine — but it is NOT a GUT departure: giving-up time is
 * measured on documented closes only, so the foraging baseline does not
 * refresh on a merge.
 * @param deps - open wiki domain.
 * @param request - the idea being merged.
 * @returns the stored adopt event.
 */
export async function adoptIdeaRemote(
  deps: LedgerDeps,
  request: {
    ideaId: string
  },
): Promise<ResearchAdoptIdeaResult> {
  const { ideaId } = request
  if (typeof ideaId !== 'string' || ideaId === '') {
    return rejected({ code: 'invalid-input', message: 'ideaId must not be empty' })
  }
  const idea = deps.domain.table('ideas').get(ideaId)
  if (idea === undefined) {
    return rejected({ code: 'invalid-input', message: `unknown ideaId: ${ideaId}` })
  }
  if (idea.status === 'adopted') {
    return rejected({ code: 'invalid-input', message: 'that line is already merged (an adoption is written once)' })
  }
  if (idea.status === 'failed') {
    return rejected({ code: 'invalid-input', message: 'a documented No is a dead end, not a merge' })
  }
  try {
    await deps.domain.table('ideas').update(ideaId, current => ({
      ...current,
      status: 'adopted' as const,
    }))
    const event = await appendEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'knowledge.idea.adopted',
      refs: { ideaId },
      payload: {},
    })
    return success({ event })
  } catch (error) {
    console.warn('[mimir]', 'the adoption could not be written', error)
    return rejected({ code: 'operation-failed', message: 'the adoption could not be written' })
  }
}

/* ------------------------------------------------------------------------ *
 * Library themes (S5): the shelf's own drift. Pure E0 counts over the
 * `papers` table — no inference, and never a reading recommendation.
 * ------------------------------------------------------------------------ */

/**
 * Read the library's theme drift: the theme mix of the papers collected in
 * one window against the equal-length window before it. `tag` themes are
 * the researcher's own words; `keyword` themes are repeated strings over
 * title+summary and are DESCRIPTIVE only. Below the floor the comparison
 * stays silent (I2's rule) while the bare counts still render. Omitted
 * bounds fall back to the last {@link DEFAULT_SPAN_DAYS} days.
 * @param deps - open wiki domain.
 * @param request - the optional window bounds.
 * @returns the derived theme layer.
 */
export async function getLibraryThemesRemote(
  deps: LedgerDeps,
  request: {
    since?: string | undefined
    until?: string | undefined
  },
): Promise<ResearchGetLibraryThemesResult> {
  try {
    const window = resolveWindow(request.since, request.until, DEFAULT_SPAN_DAYS)
    const papers = [...deps.domain.table('papers').entries()].map(([, record]) => record)
    const layer = deriveLibraryThemes(papers, window.since, window.until, Date.now())
    return success({
      themes: {
        derivedAt: layer.asOf,
        current: layer.current,
        previous: layer.previous,
        drift: layer.drift,
        newThemes: layer.newThemes,
        departedThemes: layer.departedThemes,
        speaks: layer.speaks,
      },
    })
  } catch (error) {
    console.warn('[mimir]', 'the library themes could not be derived', error)
    return rejected({ code: 'operation-failed', message: 'the library themes could not be derived' })
  }
}

/* ------------------------------------------------------------------------ *
 * Habits (S6): the researcher's own rhythm. Description only — the origin
 * rule forbids telling a researcher when to sit down.
 * ------------------------------------------------------------------------ */

/**
 * Read the habit profile: sittings (cut at the map's own session gap),
 * their median and longest length, the local hours and weekdays that carry
 * the load, and the consecutive-day streak. Hours and weekdays are LOCAL —
 * "late evening" must mean the evening the researcher lived. Silent below
 * {@link CBE_HABIT_MIN_SESSIONS}; a pure query that writes nothing.
 * @param deps - open wiki domain.
 * @param request - the optional window bounds.
 * @returns the derived habit profile.
 */
export async function getHabitsRemote(
  deps: LedgerDeps,
  request: {
    since?: string | undefined
    until?: string | undefined
  },
): Promise<ResearchGetHabitsResult> {
  try {
    const window = resolveWindow(request.since, request.until, DEFAULT_SPAN_DAYS)
    const { events } = await loadLedgerWindow(
      deps.domain,
      { since: window.since, until: window.until },
      'habits',
    )
    const profile = deriveHabits(events, window.since, window.until, Date.now())
    return success({
      habits: {
        derivedAt: profile.asOf,
        eventCount: profile.eventCount,
        sessionCount: profile.sessionCount,
        medianSessionMinutes: profile.medianSessionMinutes,
        longestSessionMinutes: profile.longestSessionMinutes,
        activeHours: profile.activeHours,
        weekdayHistogram: profile.weekdayHistogram,
        activeDays: profile.activeDays,
        currentStreakDays: profile.currentStreakDays,
        speaks: profile.speaks,
      },
    })
  } catch (error) {
    console.warn('[mimir]', 'the habit profile could not be derived', error)
    return rejected({ code: 'operation-failed', message: 'the habit profile could not be derived' })
  }
}

/* ------------------------------------------------------------------------ *
 * Journal draft (S7): the day already written out. This is the organ that
 * answers "why not Notion" — the researcher edits a draft, not a blank page.
 * ------------------------------------------------------------------------ */

/** Calendar days each draft kind covers (a month is 30 for a like-for-like span). */
const DRAFT_SPAN_DAYS: Readonly<Record<JournalDraftKind, number>> = {
  day: 1,
  week: 7,
  month: 30,
}

/**
 * Render the pre-filled journal draft: every section is a machine fact
 * written out as a sentence, and only the final bracketed slot is left for
 * words a person must supply. A pure query — it writes nothing (saving the
 * draft is {@link addJournalEntryRemote}'s job).
 * @param deps - open wiki domain.
 * @param request - the draft kind, language, and optional scope.
 * @returns the Markdown draft plus the event count it covered.
 */
export async function generateJournalDraftRemote(
  deps: LedgerDeps,
  request: {
    kind?: string | undefined
    lang?: string | undefined
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  },
): Promise<ResearchGenerateJournalDraftResult> {
  const kind = request.kind ?? 'day'
  if (kind !== 'day' && kind !== 'week' && kind !== 'month') {
    return rejected({ code: 'invalid-input', message: `kind must be 'day', 'week' or 'month', got '${kind}'` })
  }
  const lang = request.lang ?? 'zh'
  if (lang !== 'zh' && lang !== 'en') {
    return rejected({ code: 'invalid-input', message: `lang must be 'zh' or 'en', got '${lang}'` })
  }
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  try {
    const nowMs = Date.now()
    const window = resolveWindow(request.since, request.until, DRAFT_SPAN_DAYS[kind])
    const { events } = await loadLedgerWindow(deps.domain, {
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      since: window.since,
      until: window.until,
    }, 'journal draft')
    const wiki = wikiSnapshot(deps.domain)
    const papers = [...deps.domain.table('papers').entries()].map(([, record]) => record)
    const briefWindow: CbeBriefWindow = {
      since: window.since,
      until: window.until,
      projectId: request.projectId ?? null,
    }
    const brief = deriveBrief(events, wiki, briefWindow, nowMs)
    const markdown = renderJournalDraft({
      kind,
      brief,
      themes: deriveLibraryThemes(papers, window.since, window.until, nowMs),
      habits: deriveHabits(events, window.since, window.until, nowMs),
      lang,
    })
    return success({
      markdown,
      generatedAt: new Date(nowMs).toISOString(),
      kind,
      eventCount: events.length,
    })
  } catch (error) {
    return rejected({
      code: 'invalid-input',
      message: error instanceof RangeError ? error.message : 'journal draft options are invalid',
    })
  }
}

/** Report depths map to a default look-back span (days) when no bounds given. */
const DIGEST_SPAN_DAYS: Readonly<Record<CbeDigestTier, number>> = {
  weekly: 7,
  monthly: 30,
  // Project summaries default to the whole ledger (resolved from the earliest
  // event) rather than a fixed span; this value only applies when `since` is
  // supplied explicitly, in which case it is ignored.
  project: 30,
}

/**
 * Declare one Eureka — a milestone the researcher names themselves (the
 * system never declares one; it only describes the entropy a declared
 * Eureka led in with, long after the fact). Exactly one ref is required
 * (an idea or a project), the title is required and payload-capped, and the
 * event lands under the PANEL actor. No prediction is made and no
 * "you are approaching an insight" prompt is ever emitted — the EWS layers
 * only read back the lead-in window of *already declared* Eurekas.
 * @param deps - open wiki domain.
 * @param request - the ref plus the human-given title.
 * @returns the stored eureka declaration event.
 */
export async function setEurekaRemote(
  deps: LedgerDeps,
  request: {
    ideaId?: string | undefined
    projectId?: string | undefined
    title: string
  },
): Promise<ResearchSetEurekaResult> {
  const { ideaId, projectId, title } = request
  if ((ideaId === undefined) === (projectId === undefined)) {
    return rejected({
      code: 'invalid-input',
      message: 'setEureka takes exactly one of ideaId or projectId',
    })
  }
  if (typeof title !== 'string' || title.trim() === '') {
    return rejected({ code: 'invalid-input', message: 'eureka title must not be empty' })
  }
  if (title.length > EVENT_PAYLOAD_MAX_CHARS) {
    return rejected({
      code: 'invalid-input',
      message: `eureka title is capped at ${EVENT_PAYLOAD_MAX_CHARS} characters`,
    })
  }
  try {
    // Context receipt, computed BEFORE the write so it describes the road the
    // declaration caps — a pure derivation, returned (never persisted): re-
    // computing it later over the same ledger yields the same numbers.
    const foldedNow = await loadLedgerWindow(deps.domain, {}, 'setEureka context')
    const lineId = ideaId !== undefined ? ideaId : (projectId !== undefined ? `project:${projectId}` : null)
    const context = eurekaContextAt(foldedNow.events, Date.now(), lineId)
    const event = await appendEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: EUREKA_ACTION,
      refs: ideaId !== undefined ? { ideaId } : { projectId: projectId as string },
      payload: { title },
    })
    return success({ event, context })
  } catch (error) {
    console.warn('[mimir]', 'the eureka declaration could not be written', error)
    return rejected({ code: 'operation-failed', message: 'the eureka declaration could not be written' })
  }
}

/**
 * Pin (or unpin) one moment — the explicit, user-refusable bookmark of a
 * curated instant. The target is a prior event id carried in the payload
 * (the moment index reads `payload.targetEventId`); `pinned` defaults to
 * `true`. An unpin is a declaration too (a new event with `pinned: false`),
 * never a deletion — the stream stays append-only.
 * @param deps - open wiki domain.
 * @param request - the target event, optional note, and pin state.
 * @returns the stored pin event.
 */
export async function pinMomentRemote(
  deps: LedgerDeps,
  request: {
    targetEventId: string
    note?: string | undefined
    pinned?: boolean | undefined
  },
): Promise<ResearchPinMomentResult> {
  const { targetEventId, note, pinned } = request
  if (typeof targetEventId !== 'string' || targetEventId === '') {
    return rejected({ code: 'invalid-input', message: 'targetEventId must be a non-empty string' })
  }
  if (note !== undefined && note.length > EVENT_PAYLOAD_MAX_CHARS) {
    return rejected({
      code: 'invalid-input',
      message: `moment note is capped at ${EVENT_PAYLOAD_MAX_CHARS} characters`,
    })
  }
  try {
    const event = await appendEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: MOMENT_PIN_ACTION,
      refs: {},
      payload: { targetEventId, note: note ?? null, pinned: pinned ?? true },
    })
    return success({ event })
  } catch (error) {
    console.warn('[mimir]', 'the moment pin could not be written', error)
    return rejected({ code: 'operation-failed', message: 'the moment pin could not be written' })
  }
}

/**
 * Read the unified moment timeline (S9b): the five deterministic candidate
 * sources folded over the window, unified with the researcher's pins and
 * declines. Pull-only — there is no push, no notification, no ranking, and
 * every row is refusable; canonical status belongs to the declarations
 * (`cbe.moment.pin` / `cbe.eureka.set`), never to this read.
 *
 * Window discipline: the fold receives the window events PLUS a lookback
 * prefix (`since − (CBE_MOMENT_RETURN_GAP_DAYS + 1) days`) so dormancy
 * returns and lane-openings can judge line history; prefix events never
 * anchor. Truncation registers as a silence, not as a smaller truth.
 * @param deps - open wiki domain.
 * @param request - optional ISO-8601 window bounds (defaults: 30 days to now).
 * @returns the moment index view.
 */
export async function getMomentIndexRemote(
  deps: LedgerDeps,
  request: {
    since?: string | undefined
    until?: string | undefined
  } = {},
): Promise<ResearchGetMomentIndexResult> {
  for (const bound of [request.since, request.until]) {
    if (bound !== undefined && Number.isNaN(Date.parse(bound))) {
      return rejected({ code: 'invalid-input', message: `since/until must be ISO-8601, got '${bound}'` })
    }
  }
  const window = resolveWindow(request.since, request.until, DEFAULT_SPAN_DAYS)
  try {
    const folded = await loadLedgerWindow(deps.domain, {
      since: window.since,
      until: window.until,
    }, 'moment index')
    // Lookback prefix: line-history judgements (dormancy, lane-opening) read
    // before the window; the prefix never anchors a candidate.
    const prefixSince = new Date(
      Date.parse(window.since) - (CBE_MOMENT_RETURN_GAP_DAYS + 1) * MS_PER_DAY,
    ).toISOString()
    const prefixFolded = await loadLedgerWindow(deps.domain, {
      since: prefixSince,
      until: window.until,
    }, 'moment index lookback')
    // Merge window + prefix (dedupe by id) — the fold sorts canonically.
    const seen = new Set(folded.events.map(event => event.id))
    const merged = [...folded.events, ...prefixFolded.events.filter(event => !seen.has(event.id))]

    const wiki = wikiSnapshot(deps.domain)
    const labels = new Map<string, string>([
      ...wiki.ideas.map(idea => [idea.id, idea.title] as const),
      ...wiki.projects.map(project => [`project:${project.id}`, project.title] as const),
    ])

    const curated = deriveCuratedMoments(merged, window.since, window.until)
    const speaks = eurekaProfileOf(eurekaModelAt(merged), Date.now()).speaks
    const moments: readonly ResearchMomentView[] = curated.map(moment => Object.freeze({
      id: moment.id,
      at: moment.at,
      lineId: moment.lineId,
      lineLabel: moment.lineId === null ? null : labels.get(moment.lineId) ?? moment.lineId,
      kind: moment.kind,
      sources: moment.sources,
      action: moment.action,
      note: moment.note,
      pinned: moment.pinned,
      declined: moment.declined,
      canonical: moment.pinned || moment.kind === 'eureka',
      eventCount: moment.eventCount,
      stats: moment.stats,
      closeness: moment.closeness,
      evidence: moment.evidence,
    }))
    const view: ResearchMomentIndexView = Object.freeze({
      derivedAt: new Date().toISOString(),
      window: Object.freeze({ since: window.since, until: window.until }),
      retrieval: Object.freeze({
        eventsHit: folded.events.length,
        eventsTotal: folded.total,
        truncated: folded.truncated,
        silences: Object.freeze(folded.truncated
          ? [`events truncated: window matched ${folded.total}, fold cap ${LIST_EVENTS_MAX_LIMIT}, folded newest ${folded.events.length}`]
          : []),
      }),
      speaks,
      moments: Object.freeze(moments),
    })
    return success(view)
  } catch (error) {
    console.warn('[mimir]', 'the moment index could not be derived', error)
    return rejected({ code: 'operation-failed', message: 'the moment index could not be derived' })
  }
}

/**
 * Read the retrospective eureka view (S8c): every declared milestone with its
 * lead-in and control window features (the shared fold), plus the profile —
 * whose lift rows stay null below the declaration floor (I2). Descriptive
 * only: nothing here predicts or scores; the UI renders it with the same
 * "description, not prediction" note the digest carries.
 * @param deps - open wiki domain.
 * @returns the eureka view.
 */
export async function getEurekaViewRemote(
  deps: LedgerDeps,
): Promise<ResearchGetEurekaViewResult> {
  try {
    // Eureka lead-ins reach 2 × CBE_EUREKA_WINDOW_DAYS before each
    // declaration; open the whole ledger window so controls stay observable.
    const folded = await loadLedgerWindow(deps.domain, {}, 'eureka view')
    const wiki = wikiSnapshot(deps.domain)
    const labels = new Map<string, string>([
      ...wiki.ideas.map(idea => [idea.id, idea.title] as const),
      ...wiki.projects.map(project => [`project:${project.id}`, project.title] as const),
    ])
    const model = eurekaModelAt(folded.events)
    const profile = eurekaProfileOf(model, Date.now())
    const declarations = model.declarations.map((declaration, index) => {
      const lead = model.leads[index]
      const control = model.controls[index] ?? null
      return Object.freeze({
        id: declaration.id,
        at: declaration.at,
        title: declaration.title,
        lineId: declaration.lineId,
        lineLabel: declaration.lineId === null ? null : labels.get(declaration.lineId) ?? declaration.lineId,
        lead: lead as CbeWindowFeatures,
        control,
      })
    })
    const view: ResearchEurekaView = Object.freeze({
      derivedAt: new Date().toISOString(),
      declarations: Object.freeze(declarations),
      profile,
    })
    return success(view)
  } catch (error) {
    console.warn('[mimir]', 'the eureka view could not be derived', error)
    return rejected({ code: 'operation-failed', message: 'the eureka view could not be derived' })
  }
}

/**
 * Assemble one digest (weekly / monthly / project) as a pure fold over the
 * ledger, the wiki, and the papers table, then render it as MMS. The tier
 * decides depth — a weekly report is light, a project summary is heavy (it
 * adds the Eureka EWS table and the Mermaid worktree). When no `since` is
 * given, weekly/monthly fall back to their span; the project tier falls back
 * to the earliest event in the ledger so the whole history is in scope. The
 * assembled model is a plain data object — no prediction, no prompt.
 * @param deps - open wiki domain.
 * @param request - tier, window bounds, and language.
 * @returns the report model, its MMS string, and the resolved tier/lang.
 */
export async function generateDigestRemote(
  deps: LedgerDeps,
  request: ResearchGenerateDigestOptions,
): Promise<ResearchGenerateDigestResult> {
  const tier = request.tier ?? 'weekly'
  if (!(['weekly', 'monthly', 'project'] as const).includes(tier as CbeDigestTier)) {
    return rejected({
      code: 'invalid-input',
      message: `tier must be 'weekly', 'monthly' or 'project', got '${tier}'`,
    })
  }
  const safeTier = tier as CbeDigestTier
  const lang = request.lang ?? 'zh'
  if (lang !== 'zh' && lang !== 'en') {
    return rejected({ code: 'invalid-input', message: `lang must be 'zh' or 'en', got '${lang}'` })
  }
  const nowMs = Date.now()
  let window: { readonly since: string; readonly until: string }
  if (safeTier === 'project' && request.since === undefined) {
    // Explicit `oldest`: this call genuinely wants the head of history (the
    // project tier opens the whole ledger), where every other read folds the
    // newest window. Without the anchor the cap would answer "newest 1000".
    const oldest = await listEvents(deps.domain, { anchor: 'oldest', limit: 1 })
    const earliestMs = oldest.reduce((min, event) => {
      const ms = Date.parse(event.ts)
      return Number.isNaN(ms) ? min : Math.min(min, ms)
    }, nowMs)
    window = {
      since: new Date(earliestMs).toISOString(),
      until: request.until ?? new Date(nowMs).toISOString(),
    }
  } else {
    window = resolveWindow(request.since, request.until, DIGEST_SPAN_DAYS[safeTier])
  }
  try {
    const folded = await loadLedgerWindow(deps.domain, {
      since: window.since,
      until: window.until,
    }, `digest (${safeTier})`)
    const events = folded.events
    // Eureka reads a control window of `2 × CBE_EUREKA_WINDOW_DAYS` BEFORE
    // each declaration; a short digest window would make those controls
    // "unobservable" and silently drop declarations. Fetch an extended
    // lookback so the eureka model sees its baseline, while the other folds
    // keep using the (window-scoped) `events` above.
    const eurekaLookbackSince = new Date(
      Date.parse(window.since) - 2 * CBE_EUREKA_WINDOW_DAYS * MS_PER_DAY,
    ).toISOString()
    const eurekaFolded = await loadLedgerWindow(deps.domain, {
      since: eurekaLookbackSince,
      until: window.until,
    }, `digest eureka lookback (${safeTier})`)
    const wiki = wikiSnapshot(deps.domain)
    const papers = [...deps.domain.table('papers').entries()].map(([, record]) => record)
    const digest = assembleDigest({
      events,
      wiki,
      papers,
      since: window.since,
      until: window.until,
      tier: safeTier,
      nowMs,
      // Honest total: the capped window `events` is not the ledger, so hand
      // the real match count to `assembleDigest` instead of letting it fall
      // back to `events.length`.
      eventsTotal: folded.total,
      // Give eureka the extended lookback (see above) so its control windows
      // stay observable; the other folds never receive these events.
      eurekaEvents: eurekaFolded.events,
    })
    // Register a truncation as a silence rather than letting the fold cap pass
    // itself off as the whole history. `eventsTotal` is already the true
    // total inside the digest; only the silence needs appending here.
    const retrieval = Object.freeze({
      ...digest.retrieval,
      silences: folded.truncated
        ? Object.freeze([
          ...digest.retrieval.silences,
          `events 截断：窗口共 ${folded.total} 条，超过单次折叠上限 ${LIST_EVENTS_MAX_LIMIT}，本报告只折叠最新的 ${digest.retrieval.eventsHit} 条`,
        ])
        : digest.retrieval.silences,
    })
    const markdown = renderDigest({ ...digest, retrieval }, lang as 'zh' | 'en')
    return success({
      digest: { ...digest, retrieval },
      markdown,
      tier: safeTier,
      lang,
      generatedAt: new Date(nowMs).toISOString(),
    })
  } catch (error) {
    return rejected({
      code: 'invalid-input',
      message: error instanceof RangeError ? error.message : 'digest options are invalid',
    })
  }
}
