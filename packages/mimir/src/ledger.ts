/**
 * The research ledger: append-only decision-grade events, the query helpers,
 * and the progress-report renderer.
 *
 * Framing: this is a **transparent growth record**, not bookkeeping. The
 * events are the side-effect of research actions (a claim was set, an idea
 * failed with a reason, a run settled, a reviewer graded a round) — nothing
 * extra is "written down" to record growth. The renderer turns those events
 * into a 组会-ready narrative: what happened, what was learned, what the
 * current state is, and which operations were destructive — for reporting,
 * summarizing, and reviewing one's own research growth.
 *
 * Design rules (P0-1):
 * - The wiki's `events` table is the single source of truth in v1 — it is
 *   already durable and covered by the scheduled wiki backup, so a parallel
 *   file would only add a consistency surface. The progress report is the
 *   export surface.
 * - **Decision-grade only**: every state change and lifecycle flip is
 *   recorded; high-frequency reads and editor autosaves are not. The ledger
 *   is a trail for decisions, not a firehose.
 * - **Durable before the operation acknowledges, best-effort at the call
 *   sites**: call sites AWAIT the append (the event is in the table before
 *   the Remote returns) — and an `emitEvent` failure still only warns and
 *   is swallowed, because the business operation must never fail because
 *   the trail could not be written.
 * - **Append-only by convention** in v1: no remote or UI path deletes event
 *   rows. (A hard guarantee via a file-locked record+event commit is the
 *   planned P2 hardening; the table backend writes the whole domain file
 *   per change, so a lost event can at worst leave a trail gap, never a
 *   state corruption.)
 * @module dsh-mimir/src/ledger
 */

import type { EventRecord, EventRefs, LedgerActor, LedgerJsonValue, ResearchEventFilter, ResearchProgressReportOptions } from './types.ts'
import type { ResearchWikiDomain } from './store.ts'
import type { ClaimRecord, ExperimentRecord, JobRecord, ProjectRecord } from './types.ts'

/** Hard cap of one event's serialized payload (the security-style invariant of the ledger). */
export const EVENT_PAYLOAD_MAX_CHARS = 2048

/** Hard cap of one journal entry's text (the L2 layer stays one handwritten line). */
export const JOURNAL_TEXT_MAX_CHARS = 1024

/** Default and hard cap of `listEvents` results. */
export const LIST_EVENTS_DEFAULT_LIMIT = 200
export const LIST_EVENTS_MAX_LIMIT = 1000

/** How many newest events the report's detail section shows. */
const REPORT_DETAIL_MAX_EVENTS = 200

/** How many destructive-operation rows the report's risk section shows. */
const REPORT_RISK_MAX_ROWS = 50

/**
 * Monotonic suffix so same-millisecond events keep a stable order.
 * Module-level mutable state by exemption: a pure same-millisecond sequence
 * number — used only to keep event ordering stable, with no cross-instance
 * correctness impact (an id only needs to be unique and ordered) — so it is
 * not carried in `ServiceState`.
 */
let eventSeq = 0

/**
 * Whether an event is the instrument observing itself is a question about the
 * ledger's VOCABULARY, not about storage — so it is answered in
 * `./vocabulary.ts`, once, and re-exported here. This module keeps exporting
 * the two names so nothing that imports them from the ledger breaks; what it
 * no longer does is own a second copy, because two copies of "which actions
 * count as research" is exactly how the observation filter drifted out of the
 * derivation in the first place.
 */
export { OBSERVATION_ACTIONS, isObservationEvent } from './vocabulary.ts'

/** The actor behind every workbench (Remote) call in v1; session identity arrives with P1 SSE work. */
export const PANEL_ACTOR: LedgerActor = Object.freeze({ kind: 'user', id: 'panel' })
/** The actor behind host-driven lifecycle work (job settle, compile bookkeeping). */
export const SERVICE_ACTOR: LedgerActor = Object.freeze({ kind: 'system', id: 'service' })
/** The actor behind the `wiki_note` tool's writes. */
export const WIKI_AGENT_ACTOR: LedgerActor = Object.freeze({ kind: 'agent', id: 'wiki_note' })
/** The actor behind the independent reviewer subagent. */
export const REVIEWER_ACTOR: LedgerActor = Object.freeze({ kind: 'subagent', id: 'reviewer' })

/** Input to one ledger append (everything except the generated id and ts). */
export interface LedgerEventInput {
  readonly actor: LedgerActor
  readonly action: string
  readonly refs?: EventRefs | undefined
  /** JSON-constrained: the payload crosses the Remote boundary via `listEvents`. */
  readonly payload?: Record<string, LedgerJsonValue> | undefined
  /** Injectable clock (tests); `new Date()` by default. */
  readonly now?: Date | undefined
}

/**
 * Truncate one payload to the ledger's cap: a payload whose JSON form fits
 * passes through unchanged (empty objects stay `{}`); an over-cap payload
 * becomes a marker object carrying the first part of its JSON form.
 * @param payload - the caller's context.
 * @returns a payload whose serialized form never exceeds the cap.
 */
export function truncatePayload(payload: Record<string, LedgerJsonValue>): Record<string, LedgerJsonValue> {
  const json = JSON.stringify(payload) ?? '{}'
  if (json.length <= EVENT_PAYLOAD_MAX_CHARS) return payload
  return Object.freeze({
    _truncated: true,
    preview: json.slice(0, 1024),
  })
}

/**
 * Build one event: the id is `ev-<time36>-<seq36>` (unique across
 * same-millisecond appends; the table key needs only uniqueness, the `ts`
 * field carries the order).
 * @param input - actor, action, refs, payload, and an optional clock.
 * @returns the full event ready to append.
 */
export function newEvent(input: LedgerEventInput): EventRecord {
  const now = input.now ?? new Date()
  eventSeq += 1
  return Object.freeze({
    id: `ev-${now.getTime().toString(36)}-${eventSeq.toString(36)}`,
    ts: now.toISOString(),
    actor: input.actor,
    action: input.action,
    refs: Object.freeze({ ...(input.refs ?? {}) }),
    payload: Object.freeze(truncatePayload(input.payload ?? {})),
  })
}

/**
 * Append one event to the wiki's `events` table.
 * @param domain - the plugin-owned open research-wiki domain.
 * @param input - actor, action, refs, payload, and an optional clock.
 * @returns the stored event (with its generated id/ts).
 */
export async function appendEvent(domain: ResearchWikiDomain, input: LedgerEventInput): Promise<EventRecord> {
  const event = newEvent(input)
  await domain.table('events').put(event.id, event)
  return event
}

/**
 * Best-effort append: the call-site contract. A ledger failure is warned
 * and swallowed — the surrounding business operation must never fail
 * because the trail could not be written.
 * @param domain - the plugin-owned open research-wiki domain.
 * @param input - actor, action, refs, payload, and an optional clock.
 */
export async function emitEvent(domain: ResearchWikiDomain, input: LedgerEventInput): Promise<void> {
  try {
    await appendEvent(domain, input)
  } catch (error) {
    console.warn('[mimir] ledger append failed:', error)
  }
}

/** Validate one `listEvents` limit (default, then integer 1..cap). */
function limitOf(filter: ResearchEventFilter): number {
  const limit = filter.limit ?? LIST_EVENTS_DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_EVENTS_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${LIST_EVENTS_MAX_LIMIT}`)
  }
  return limit
}

/**
 * Every event matching `filter`'s predicates, ascending by (ts, id). The
 * `limit`/`order`/`anchor` fields are NOT applied here — this is the shared
 * scan behind both the windowed query and the uncapped count.
 */
async function matchingEvents(
  domain: ResearchWikiDomain,
  filter: ResearchEventFilter,
): Promise<EventRecord[]> {
  const sinceMs = filter.since === undefined ? null : Date.parse(filter.since)
  const untilMs = filter.until === undefined ? null : Date.parse(filter.until)
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new RangeError(`since is not a valid timestamp: ${filter.since}`)
  if (untilMs !== null && Number.isNaN(untilMs)) throw new RangeError(`until is not a valid timestamp: ${filter.until}`)
  const kind = filter.actorKind
  const prefix = filter.actionPrefix
  const events: EventRecord[] = []
  for (const [, record] of domain.table('events').entries()) {
    if (filter.projectId !== undefined && record.refs.projectId !== filter.projectId) continue
    if (kind !== undefined && record.actor.kind !== kind) continue
    if (prefix !== undefined && !record.action.startsWith(prefix)) continue
    const ms = Date.parse(record.ts)
    if (sinceMs !== null && ms < sinceMs) continue
    if (untilMs !== null && ms >= untilMs) continue
    events.push(record)
  }
  events.sort((left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id))
  return events
}

/**
 * Query the ledger: filter by project ref, actor kind, action prefix, and
 * ISO-8601 time bounds (inclusive `since`, exclusive `until`), sort by
 * (ts, id), and cap the result.
 *
 * The cap is a sliding window over the **newest** matches (default), not the
 * oldest: every CBE organ is a pure fold over `listEvents`, so a head-of-
 * history window would freeze worktree, habits, foraging, eureka, the
 * evidence model, and the digest at the first `limit` events ever written —
 * permanently, and with no error. {@link countEvents} reports the uncapped
 * total so a truncated window can say so.
 *
 * @param domain - the plugin-owned open research-wiki domain.
 * @param filter - optional filters; see {@link ResearchEventFilter}.
 * @returns the matching events in the requested order (still time-ascending
 * unless `order: 'desc'`, so downstream folds see a chronological stream).
 */
export async function listEvents(
  domain: ResearchWikiDomain,
  filter: ResearchEventFilter = {},
): Promise<readonly EventRecord[]> {
  const limit = limitOf(filter)
  const events = await matchingEvents(domain, filter)
  // `anchor: 'oldest'` is the explicit exception for callers that genuinely
  // want the head of history (e.g. the digest's "earliest event in the
  // ledger"); everything else folds the live end of the ledger.
  const window = filter.anchor === 'oldest' ? events.slice(0, limit) : events.slice(-limit)
  if (filter.order === 'desc') window.reverse()
  return Object.freeze(window)
}

/**
 * Count every event matching `filter`, ignoring {@link ResearchEventFilter}'s
 * `limit` — the true total behind a possibly truncated {@link listEvents}
 * window, so a caller can report truncation instead of passing the capped
 * length off as the whole story.
 * @param domain - the plugin-owned open research-wiki domain.
 * @param filter - optional filters (the `limit` field is not accepted: a
 * count has no window).
 * @returns the number of matching events.
 */
export async function countEvents(
  domain: ResearchWikiDomain,
  filter: Omit<ResearchEventFilter, 'limit' | 'order' | 'anchor'> = {},
): Promise<number> {
  return (await matchingEvents(domain, filter)).length
}

/* ------------------------------------------------------------------------ *
 * Progress report (the growth-record renderer)
 * ------------------------------------------------------------------------ */

/** One row of the report's destructive-operations section. */
interface RiskRow {
  readonly ts: string
  readonly actor: string
  readonly action: string
  readonly detail: string
}

/** Human-readable form of one actor. */
function actorOf(record: EventRecord): string {
  return `${record.actor.kind}/${record.actor.id}`
}

/** Compact one-line form of a payload for report tables. */
function payloadLine(payload: Record<string, unknown>): string {
  if (Object.keys(payload).length === 0) return '—'
  const json = JSON.stringify(payload)
  return json.length > 120 ? `${json.slice(0, 119)}…` : json
}

/** One line, backticked, of a possibly-absent string field. */
function firstLine(value: string | undefined): string {
  const line = (value ?? '').split('\n')[0] ?? ''
  return line.length === 0 ? '—' : `\`${line.length > 80 ? `${line.slice(0, 79)}…` : line}\``
}

/** Human-readable form of one duration in milliseconds, or `—`. */
function secondsOf(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${String(totalSeconds)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${String(minutes)}m${String(seconds)}s`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${String(hours)}h` : `${String(hours)}h${String(restMinutes)}m`
}

/** The report's project scoping: the record plus a display title. */
function projectScope(domain: ResearchWikiDomain, options: ResearchProgressReportOptions): { project?: ProjectRecord | undefined; title: string } {
  if (options.projectId === undefined) {
    const projects = [...domain.table('projects').entries()].map(([, record]) => record)
    return {
      title: projects.length === 0
        ? 'all projects (0)'
        : `all projects (${String(projects.length)})`,
    }
  }
  const project = domain.table('projects').get(options.projectId)
  return { project, title: project === undefined ? options.projectId : `${project.title} (${project.id})` }
}

/** Plural marker for count phrases. */
function s(n: number): string {
  return n === 1 ? '' : 's'
}

/**
 * The report's one-line TL;DR over a window: the decision-grade moves in the
 * order a 组会 listener wants to hear them — understanding (claims/ideas),
 * experiments, reviews, writing, risk. Only non-zero parts appear; an empty
 * window reads as quiet, not as missing.
 */
function tldrOf(events: readonly EventRecord[]): string {
  const parts: string[] = []
  const claimMoves = events.filter(event => event.refs.claimId !== undefined).length
  if (claimMoves > 0) parts.push(`${claimMoves} claim update${s(claimMoves)}`)
  const ideaMoves = events.filter(event => event.refs.ideaId !== undefined).length
  if (ideaMoves > 0) parts.push(`${ideaMoves} idea update${s(ideaMoves)}`)
  const settled = events.filter(event => event.action === 'compute.job.settled')
  if (settled.length > 0) {
    const succeeded = settled.filter(event => event.payload['status'] === 'succeeded').length
    parts.push(`${settled.length} run${s(settled.length)} settled (${succeeded} succeeded)`)
  }
  const rounds = events.filter(event => event.action === 'review.round.settled')
  if (rounds.length > 0) {
    const verdicts = rounds.map(event => String(event.payload['verdict'] ?? 'unknown')).join(' / ')
    parts.push(`${rounds.length} review round${s(rounds.length)} (${verdicts})`)
  }
  const litWriting = events.filter(event =>
    event.action.startsWith('literature.')
    || event.action.startsWith('writing.')
    || event.action.startsWith('figures.')).length
  if (litWriting > 0) parts.push(`${litWriting} literature/writing event${s(litWriting)}`)
  const destructive = events.filter(event => event.payload['destructive'] === true).length
  if (destructive > 0) parts.push(`${destructive} destructive op${s(destructive)}`)
  return parts.length === 0 ? 'quiet window — no decision-grade events' : parts.join(' · ')
}

/**
 * Render the research progress report: a growth-organized Markdown document
 * over the ledger plus the current wiki state (claims, experiments, jobs).
 * It is a pure query — it reads the domain and returns text, writing
 * nothing.
 *
 * The sections follow a 组会 / reporting flow — first what happened and
 * what was learned (the growth), then the current state, and the
 * destructive-operations ledger as the closing risk footnote rather than the
 * headline:
 *
 * 1. header + **TL;DR** (one line, skimmable in 10 seconds),
 * 2. `## Progress` — every event in the window, newest first (the full
 *    timeline),
 * 3. `## Learning & judgment changes` — the growth: claim transitions,
 *    ideas added/failed (with reasons), review verdicts,
 * 4. `## Current state` — counts at report time,
 * 5. `## Claim ledger` — each claim with its last ledgered change,
 * 6. `## Experiments & runs` — runs, metrics, and the settled-job detail,
 * 7. `## Destructive & high-risk operations` — the risk footnote.
 *
 * A time window (`since` inclusive, `until` exclusive) turns the same
 * renderer into a weekly 组会 report — e.g. `since` = 7 days before now.
 * @param domain - the plugin-owned open research-wiki domain.
 * @param options - project filter and ISO-8601 bounds.
 * @param now - injectable clock for the `Generated` line.
 * @returns the Markdown report.
 */
export async function buildProgressReport(
  domain: ResearchWikiDomain,
  options: ResearchProgressReportOptions = {},
  now: Date = new Date(),
): Promise<string> {
  const { title } = projectScope(domain, options)
  const since = options.since
  const until = options.until
  const events = await listEvents(domain, {
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    order: 'asc',
    limit: LIST_EVENTS_MAX_LIMIT,
  })

  const projects = [...domain.table('projects').entries()].map(([, record]) => record)
    .filter(record => options.projectId === undefined || record.id === options.projectId)
  const claims = [...domain.table('claims').entries()].map(([, record]) => record)
  const experiments = [...domain.table('experiments').entries()].map(([, record]) => record)
    .filter(record => options.projectId === undefined || record.projectId === options.projectId)
  const jobs = [...domain.table('jobs').entries()].map(([, record]) => record)
    .filter(record => {
      if (options.projectId === undefined) return true
      // Jobs carry no project ref of their own; scope through the experiment.
      if (record.experimentId === undefined) return false
      const experiment = domain.table('experiments').get(record.experimentId)
      return experiment !== undefined && experiment.projectId === options.projectId
    })
  const papers = [...domain.table('papers').entries()].map(([, record]) => record)

  const countBy = <T,>(values: readonly T[], pick: (value: T) => string): Map<string, number> => {
    const map = new Map<string, number>()
    for (const value of values) {
      const key = pick(value)
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }
  const render = (map: Map<string, number>): string =>
    map.size === 0 ? '0' : [...map.entries()].map(([key, n]) => `${key} ${String(n)}`).join(' · ')

  const actorCounts = countBy(events, record => record.actor.kind)

  const settledJobs = events.filter(event => event.action === 'compute.job.settled')
  const jobWallMs = settledJobs.reduce((sum, event) => {
    const duration = event.payload['durationMs']
    return sum + (typeof duration === 'number' ? duration : 0)
  }, 0)
  const reviewRounds = events.filter(event => event.action === 'review.round.settled')
  const reviewCounts = countBy(reviewRounds, event => String(event.payload['verdict'] ?? 'unknown'))

  const newestFirst = (left: EventRecord, right: EventRecord): number =>
    right.ts.localeCompare(left.ts) || right.id.localeCompare(left.id)

  const lines: string[] = []
  const push = (line = ''): void => { lines.push(line) }

  push('# Mimir Research Progress Report')
  push()
  push(`- **Project:** ${title}`)
  push(`- **Period:** ${since === undefined ? 'full history' : since} → ${until === undefined ? 'now' : until}`)
  push(`- **Generated:** ${now.toISOString()}`)
  push(`- **Window:** ${String(events.length)} event(s)`)
  push(`- **TL;DR:** ${tldrOf(events)}`)
  push()

  // Progress: the complete window, newest first — the full timeline of the
  // period (the old "events detail" section, now the report's lead).
  push(`## Progress (newest ${String(Math.min(REPORT_DETAIL_MAX_EVENTS, events.length))} of ${String(events.length)})`)
  push()
  if (events.length === 0) {
    push('_no activity in window_')
  } else {
    push('| Time | Actor | Action | Refs | Detail |')
    push('| --- | --- | --- | --- | --- |')
    for (const event of [...events].sort(newestFirst).slice(0, REPORT_DETAIL_MAX_EVENTS)) {
      const refs = Object.entries(event.refs).map(([key, value]) => `${key}=${String(value)}`).join(' ')
      push(`| ${event.ts} | ${actorOf(event)} | \`${event.action}\` | ${refs === '' ? '—' : refs} | ${payloadLine(event.payload)} |`)
    }
  }
  push()

  // Learning & judgment changes: the growth. Claim transitions (with the
  // new status), ideas added/failed (with the reason), and review verdicts
  // — what the project's understanding changed to during the window.
  const learning = events.filter(event =>
    event.refs.claimId !== undefined
    || event.refs.ideaId !== undefined
    || event.action.startsWith('review.'))
  push('## Learning & judgment changes')
  push()
  if (learning.length === 0) {
    push('_no judgment changes in window_')
  } else {
    push('| Time | Actor | What changed | Detail |')
    push('| --- | --- | --- | --- |')
    for (const event of [...learning].sort(newestFirst)) {
      const status = typeof event.payload['status'] === 'string' ? ` → ${String(event.payload['status'])}` : ''
      push(`| ${event.ts} | ${actorOf(event)} | \`${event.action}\`${status} | ${payloadLine(event.payload)} |`)
    }
  }
  push()

  // Current state at report time.
  push('## Current state')
  push()
  push('| Dimension | Value |')
  push('| --- | --- |')
  push(`| Projects | ${projects.length === 0 ? '0' : `${String(projects.length)} (${render(countBy(projects, record => record.stage))})` } |`)
  push(`| Claims | ${render(countBy(claims, record => record.status))} |`)
  push(`| Experiments | ${render(countBy(experiments, record => record.status))} |`)
  // Wall time comes from the settled ledger events, not the jobs table: a
  // settled run's duration stays auditable even if the job row is pruned.
  push(`| Remote jobs | ${render(countBy(jobs, record => record.status))}${settledJobs.length > 0 ? ` · wall ${secondsOf(jobWallMs)}` : ''} |`)
  push(`| Papers in library | ${String(papers.length)} |`)
  push(`| Review rounds | ${render(reviewCounts)} |`)
  push(`| Actors | ${render(actorCounts)} |`)
  push()

  // The claim ledger with each claim's last ledgered change.
  const lastChangeByClaim = new Map<string, EventRecord>()
  for (const event of events) {
    const claimId = event.refs.claimId
    if (claimId !== undefined) lastChangeByClaim.set(claimId, event)
  }
  push('## Claim ledger')
  push()
  if (claims.length === 0) {
    push('_no claims recorded_')
  } else {
    push('| Claim | Status | Evidence | Last ledgered change |')
    push('| --- | --- | --- | --- |')
    for (const claim of claims) {
      const change = lastChangeByClaim.get(claim.id)
      const changeLine = change === undefined
        ? '—'
        : `${change.ts} \`${change.action}\` (${actorOf(change)}${typeof change.payload['status'] === 'string' ? ` → ${String(change.payload['status'])}` : ''})`
      push(`| ${claim.text.length > 60 ? `${claim.text.slice(0, 59)}…` : claim.text} | ${claim.status} | ${firstLine(claim.evidence)} | ${changeLine} |`)
    }
  }
  push()

  // Experiments & runs, newest first, with the settled-job detail.
  push('## Experiments & runs')
  push()
  if (experiments.length === 0) {
    push('_no experiment runs recorded_')
  } else {
    push('| Id | Project | Name | Status | Metrics | Last job | Updated |')
    push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const experiment of [...experiments].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
      const metrics = Object.entries(experiment.metrics)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(', ')
      const last = experiment.lastJob
      const lastLine = last === undefined
        ? '—'
        : `${last.status} (exit ${last.exitCode === null ? 'n/a' : String(last.exitCode)}, ${secondsOf(last.durationMs)})`
      push(`| \`${experiment.id}\` | ${experiment.projectId} | ${experiment.name} | ${experiment.status} | ${metrics === '' ? '—' : metrics} | ${lastLine} | ${experiment.updatedAt} |`)
    }
  }
  if (jobs.length > 0) {
    push()
    push('Remote jobs (newest first):')
    push()
    for (const job of [...jobs].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 20)) {
      const duration = job.startedAt !== undefined && job.finishedAt !== undefined
        ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt))
        : null
      push(`- \`${job.id}\` ${job.status} on \`${job.serverId}\` (exit ${job.exitCode === null ? 'n/a' : String(job.exitCode)}, ${secondsOf(duration)}): ${firstLine(job.command)}`)
    }
  }
  push()

  // Destructive & high-risk operations — the closing risk footnote. A
  // progress report leads with what happened and what was learned; an
  // advisor or an integrity reviewer digs this out when they need it.
  const riskRows: RiskRow[] = events
    .filter(event => event.payload['destructive'] === true)
    .map(event => ({
      ts: event.ts,
      actor: actorOf(event),
      action: event.action,
      detail: payloadLine(event.payload),
    }))
    .sort((left, right) => right.ts.localeCompare(left.ts))
  push('## Destructive & high-risk operations')
  push()
  if (riskRows.length === 0) {
    push('_none in window_')
  } else {
    push('| Time | Actor | Action | Detail |')
    push('| --- | --- | --- | --- |')
    for (const row of riskRows.slice(0, REPORT_RISK_MAX_ROWS)) {
      push(`| ${row.ts} | ${row.actor} | \`${row.action}\` | ${row.detail} |`)
    }
  }
  push()

  return lines.join('\n')
}


/**
 * Convenience for callers that only need a claim's record (the report and
 * future provenance views resolve claims by id).
 * @param domain - the plugin-owned open research-wiki domain.
 * @param id - the claim id.
 * @returns the claim, or undefined.
 */
export function claimOf(domain: ResearchWikiDomain, id: string): ClaimRecord | undefined {
  return domain.table('claims').get(id)
}

/** Convenience for the report's experiment scoping tests. */
export function experimentOf(domain: ResearchWikiDomain, id: string): ExperimentRecord | undefined {
  return domain.table('experiments').get(id)
}

/** Convenience for the report's job scoping tests. */
export function jobOf(domain: ResearchWikiDomain, id: string): JobRecord | undefined {
  return domain.table('jobs').get(id)
}
