/**
 * Venue-deadline domain service: the fetch/cache shell around the pure fold
 * in `../venue-deadlines.ts`. The ccfddl aggregate YAML is fetched on a timer
 * (first pass right after plugin start, then every six hours), parsed, and
 * stored as JSON at `<workspaceDir>/venue-deadlines.cache.json` — reads never
 * touch the network, so the panel and the `venue_search` tool keep working
 * offline on the last good snapshot, and a failed refresh silently keeps it.
 * @module dsh-mimir/src/services/venue-deadlines
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  CCF_A_JOURNALS,
  currentConfOf,
  parseAllconfYaml,
  parseCcfddlInstant,
  queryVenues,
  type VenueQuery,
  type VenueSeries,
} from '../venue-deadlines.ts'
import type {
  ResearchRefreshVenueDeadlinesResult,
  ResearchSetVenueWatchResult,
  ResearchVenueDeadlinesResult,
  VenueConfView,
  VenueDeadlineView,
} from '../types.ts'
import { success, rejected } from './common.ts'
import { startScheduledLoop, type TaskHealthRegistry } from '../task-health.ts'
import type { WikiAdminDeps } from './wiki-admin.ts'

/** The upstream aggregate (community-maintained ccfddl/ccf-deadlines). */
export const CCFDDL_ALLCONF_URL = 'https://ccfddl.github.io/conference/allconf.yml'
/** Cache file name under the workspace root. */
export const VENUE_CACHE_FILE = 'venue-deadlines.cache.json'
/** Refresh cadence: the catalog moves on human timescales, six hours is plenty. */
export const VENUE_REFRESH_INTERVAL_MS = 6 * 3_600_000
/** One fetch attempt's ceiling. */
export const VENUE_FETCH_TIMEOUT_MS = 30_000

/** The durable cache envelope on disk. */
interface VenueCache {
  readonly fetchedAt: string
  readonly venues: readonly VenueSeries[]
}

/** In-flight cache refreshes keyed by workspace, so timer and manual calls share one fetch. */
const activeVenueRefreshes = new Map<string, Promise<VenueCache>>()

/**
 * Whether one cached record is a well-formed series. The cache is validated
 * per record rather than per file: one malformed entry (a hand edit, a write
 * cut short mid-array) must not take the whole catalog down with it (#241).
 * Checks exactly the fields the folds dereference.
 */
function isVenueSeriesRecord(value: unknown): value is VenueSeries {
  if (typeof value !== 'object' || value === null) return false
  const series = value as Record<string, unknown>
  if (typeof series['key'] !== 'string' || series['key'] === '') return false
  if (typeof series['title'] !== 'string') return false
  if (typeof series['description'] !== 'string') return false
  if (typeof series['sub'] !== 'string') return false
  if (!['A', 'B', 'C', 'N'].includes(series['ccfRank'] as string)) return false
  if (typeof series['dblp'] !== 'string' && series['dblp'] !== null) return false
  if (!Array.isArray(series['confs'])) return false
  return series['confs'].every((conf: unknown) => {
    if (typeof conf !== 'object' || conf === null) return false
    const entry = conf as Record<string, unknown>
    if (typeof entry['year'] !== 'number') return false
    if (typeof entry['id'] !== 'string') return false
    if (typeof entry['link'] !== 'string') return false
    if (typeof entry['timezone'] !== 'string') return false
    if (typeof entry['date'] !== 'string') return false
    if (typeof entry['place'] !== 'string') return false
    return Array.isArray(entry['timeline'])
  })
}

/** Deps of the venue-deadline handlers: workspace root plus the wiki domain. */
export type VenueDeadlineDeps = WikiAdminDeps & { readonly workspaceDir: string }

/** Injectable fetch seam (tests substitute the network). */
export type VenueFetch = (url: string, signal: AbortSignal) => Promise<string>

/** The default fetch: plain global fetch with HTTP-status validation. */
async function defaultFetch(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`ccfddl fetch failed: HTTP ${response.status} for ${url}`)
  return response.text()
}

/** Read the cached catalog; a missing or corrupt cache is `null`, never a throw. */
export async function loadVenueCache(workspaceDir: string): Promise<VenueCache | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(workspaceDir, VENUE_CACHE_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const cache = parsed as Partial<VenueCache>
    if (typeof cache.fetchedAt !== 'string' || !Array.isArray(cache.venues)) return null
    // Per-record, not per-file: keep the good series, drop the bad ones
    // instead of failing the whole batch (#241).
    return { fetchedAt: cache.fetchedAt, venues: cache.venues.filter(isVenueSeriesRecord) }
  } catch {
    return null
  }
}

/**
 * Fetch the upstream catalog and replace the cache atomically. Parse or
 * transport failures reject; the caller decides whether the old cache
 * survives (the loop always keeps it).
 * @param workspaceDir - workspace root the cache lives under.
 * @param fetchImpl - fetch seam (the real network outside tests).
 * @returns the fresh cache.
 */
async function refreshVenueCacheUnlocked(workspaceDir: string, fetchImpl: VenueFetch): Promise<VenueCache> {
  const text = await fetchImpl(CCFDDL_ALLCONF_URL, AbortSignal.timeout(VENUE_FETCH_TIMEOUT_MS))
  const venues = parseAllconfYaml(text)
  if (venues.length === 0) throw new Error('ccfddl payload parsed to an empty catalog')
  const cache: VenueCache = { fetchedAt: new Date().toISOString(), venues: Object.freeze(venues) }
  await writeFileAtomic(join(workspaceDir, VENUE_CACHE_FILE), JSON.stringify(cache), { mode: 0o666 })
  return cache
}

export async function refreshVenueCache(workspaceDir: string, fetchImpl: VenueFetch = defaultFetch): Promise<VenueCache> {
  const active = activeVenueRefreshes.get(workspaceDir)
  if (active !== undefined) return active

  const refresh = refreshVenueCacheUnlocked(workspaceDir, fetchImpl)
  activeVenueRefreshes.set(workspaceDir, refresh)
  try {
    return await refresh
  } finally {
    if (activeVenueRefreshes.get(workspaceDir) === refresh) activeVenueRefreshes.delete(workspaceDir)
  }
}

/** Options for {@link startVenueDeadlineLoop}. */
export interface VenueDeadlineLoopOptions {
  /** The absolute research workspace root. */
  readonly workspaceDir: string
  /** Refresh cadence in milliseconds (default {@link VENUE_REFRESH_INTERVAL_MS}). */
  readonly intervalMs?: number
  /** Delay of the FIRST refresh in milliseconds (default 2s — startup stays fast). */
  readonly firstDelayMs?: number
  /** Shared scheduled-task health book (#223); every pass is recorded. */
  readonly health: TaskHealthRegistry
  /** Failure sink: refresh errors land here and the loop keeps going. */
  readonly onError: (error: unknown) => void
  /** Fetch seam (tests). */
  readonly fetchImpl?: VenueFetch
}

/** Health-book key of the venue-deadline refresh loop. */
export const VENUE_DEADLINE_TASK = 'venue-deadlines'

/**
 * Start the refresh loop: first pass shortly after plugin start, then every
 * `intervalMs` after the previous pass settles, stretched by the shared
 * backoff after consecutive failures (#223). A failed pass leaves the
 * previous cache untouched. The timer is unref'd so it never holds the
 * process open.
 * @returns dispose: clears the pending timer (an in-flight pass finishes).
 */
export function startVenueDeadlineLoop(options: VenueDeadlineLoopOptions): () => void {
  return startScheduledLoop({
    name: VENUE_DEADLINE_TASK,
    health: options.health,
    intervalMs: options.intervalMs ?? VENUE_REFRESH_INTERVAL_MS,
    firstDelayMs: options.firstDelayMs ?? 2_000,
    run: () => refreshVenueCache(options.workspaceDir, options.fetchImpl),
    onError: options.onError,
  })
}

/** Render one edition for the wire: deadlines become ISO instants. */
function confViewOf(conf: VenueSeries['confs'][number]): VenueConfView {
  return Object.freeze({
    year: conf.year,
    id: conf.id,
    link: conf.link,
    date: conf.date,
    place: conf.place,
    timeline: Object.freeze(conf.timeline.map(round => Object.freeze({
      abstractDeadline: round.abstractDeadline === null ? null : isoOrNull(round.abstractDeadline, conf.timezone),
      deadline: round.deadline === null ? null : isoOrNull(round.deadline, conf.timezone),
      comment: round.comment,
    }))),
  })
}

/** One raw ccfddl wall time as an ISO instant, or null when unparseable. */
function isoOrNull(value: string, timezone: string): string | null {
  const atMs = parseCcfddlInstant(value, timezone)
  return atMs === null ? null : new Date(atMs).toISOString()
}

/**
 * The panel's catalog read: every series with its current edition resolved,
 * the watch list of the addressed project, and the cache age. An empty cache
 * (first ever start, offline) yields an empty list with `fetchedAt: null` —
 * never a failure, so the view renders its empty state instead of an error.
 * @param deps - workspace root and open domain.
 * @param request - the project whose watch list rides along.
 * @returns the catalog view.
 */
export async function listVenueDeadlines(
  deps: VenueDeadlineDeps,
  request: { readonly projectId?: string | undefined },
): Promise<ResearchVenueDeadlinesResult> {
  const cache = await loadVenueCache(deps.workspaceDir)
  const nowMs = Date.now()
  const venues: VenueDeadlineView[] = (cache?.venues ?? []).flatMap((series) => {
    const current = currentConfOf(series, nowMs)
    if (current === null) return []
    return [Object.freeze({
      key: series.key,
      title: series.title,
      description: series.description,
      sub: series.sub,
      ccfRank: series.ccfRank,
      dblp: series.dblp,
      conf: confViewOf(current.conf),
      nextDeadlineAt: current.next === null ? null : new Date(current.next.atMs).toISOString(),
      nextDeadlineKind: current.next === null ? null : current.next.kind,
    })]
  })
  const watched: string[] = []
  if (request.projectId !== undefined) {
    const prefix = `${request.projectId}:`
    for (const [id] of deps.domain.table('venue_watches').entries()) {
      if (id.startsWith(prefix)) watched.push(id.slice(prefix.length))
    }
  }
  return success({
    venues: Object.freeze(venues),
    journals: CCF_A_JOURNALS,
    watched: Object.freeze(watched.sort()),
    fetchedAt: cache?.fetchedAt ?? null,
  })
}

/**
 * Flip one series in one project's watch list; the composite row id is
 * `<projectId>:<seriesKey>`. An unknown project is `project-not-found`.
 * @param deps - workspace root and open domain.
 * @param request - project, series key, and the target state.
 * @returns the settled watch state.
 */
export async function setVenueWatch(
  deps: VenueDeadlineDeps,
  request: { readonly projectId: string; readonly series: string; readonly watched: boolean },
): Promise<ResearchSetVenueWatchResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
  const series = request.series.trim().toLowerCase()
  if (series === '') return rejected({ code: 'invalid-input', message: 'series must be non-empty' })
  const id = `${request.projectId}:${series}`
  const table = deps.domain.table('venue_watches')
  if (request.watched) {
    if (table.get(id) === undefined) {
      await table.put(id, { id, projectId: request.projectId, series, createdAt: new Date().toISOString() })
    }
  } else if (table.get(id) !== undefined) {
    await table.delete(id)
  }
  return success({ projectId: request.projectId, series, watched: request.watched })
}

/**
 * The panel's manual refresh: fetch now, keep the old cache on failure
 * (reported as `operation-failed` so the view can toast it).
 * @param deps - workspace root and open domain.
 * @returns the fresh fetch timestamp.
 */
export async function refreshVenueDeadlines(deps: VenueDeadlineDeps): Promise<ResearchRefreshVenueDeadlinesResult> {
  try {
    const cache = await refreshVenueCache(deps.workspaceDir)
    return success({ fetchedAt: cache.fetchedAt })
  } catch (error) {
    return rejected({ code: 'operation-failed', message: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Answer one `venue_search` tool call against the cache (never the network).
 * @param workspaceDir - workspace root the cache lives under.
 * @param query - name/rank/field/window narrowing.
 * @param nowMs - the reference instant (injectable for tests).
 * @returns the matching cards, or null when no cache exists yet.
 */
export async function searchVenueCache(
  workspaceDir: string,
  query: VenueQuery,
  nowMs = Date.now(),
) {
  const cache = await loadVenueCache(workspaceDir)
  if (cache === null) return null
  return {
    fetchedAt: cache.fetchedAt,
    results: queryVenues(cache.venues, query, nowMs).map(card => ({
      title: card.series.title,
      description: card.series.description,
      sub: card.series.sub,
      ccfRank: card.series.ccfRank,
      year: card.conf.year,
      link: card.conf.link,
      date: card.conf.date,
      place: card.conf.place,
      nextDeadlineAt: card.next === null ? null : new Date(card.next.atMs).toISOString(),
      nextDeadlineKind: card.next === null ? null : card.next.kind,
      daysLeft: card.next === null ? null : Math.ceil((card.next.atMs - nowMs) / 86_400_000),
      timeline: card.conf.timeline.map(round => ({
        abstractDeadline: round.abstractDeadline === null ? null : isoOrNull(round.abstractDeadline, card.conf.timezone),
        deadline: round.deadline === null ? null : isoOrNull(round.deadline, card.conf.timezone),
        comment: round.comment,
      })),
    })),
  }
}
