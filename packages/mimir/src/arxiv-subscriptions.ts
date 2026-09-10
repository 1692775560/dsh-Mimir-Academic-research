/**
 * arXiv subscription storage and new-paper checks: the subscription list
 * persists as one JSON file, `<workspaceDir>/arxiv-subscriptions.json`,
 * written atomically (via `@deepseek-ai/dsh-atomic-write`) — pure filesystem
 * storage, nothing here touches the wiki domain. A check pulls each
 * subscription's newest submissions through `fetchArxivSearch`, diffs them
 * against the record's `seenIds`, and accumulates the freshly surfaced
 * entries (ids plus cached details) onto the record. Checks run serially
 * with a polite gap between requests (arXiv asks API clients for ~3s);
 * {@link startArxivSubscriptionLoop} is the thin timer shell the plugin's
 * apply mounts for the scheduled daily check.
 * @module dsh-mimir/src/arxiv-subscriptions
 */

import { lstat, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { isNotFound } from './paper-source.ts'
import { fetchArxivSearch } from './tools/arxiv.ts'
import { startScheduledLoop, type TaskHealthRegistry } from './task-health.ts'
import type { ArxivEntry } from './tools/arxiv.ts'

/** The workspace-relative file the subscription list persists in. */
export const ARXIV_SUBSCRIPTIONS_FILE = 'arxiv-subscriptions.json'
/** Cap of one record's `seenIds` (the diff memory never grows unboundedly). */
export const ARXIV_SUBSCRIPTION_SEEN_LIMIT = 500
/** Cap of one record's accumulated new-entry list (ids and cached details). */
export const ARXIV_SUBSCRIPTION_NEW_LIMIT = 100
/** Maximum length of one subscription query. */
export const ARXIV_SUBSCRIPTION_QUERY_MAX = 200
/** How many of the newest submissions one check pulls per subscription. */
export const ARXIV_SUBSCRIPTION_CHECK_RESULTS = 25
/** Timeout of one check's arXiv request (same style as the panel's search). */
export const ARXIV_SUBSCRIPTION_FETCH_TIMEOUT_MS = 15_000
/** Polite gap between two subscriptions' requests within one check run. */
export const ARXIV_SUBSCRIPTION_GAP_MS = 3_000
/** How long after plugin start the FIRST scheduled check runs. */
export const ARXIV_SUBSCRIPTION_FIRST_DELAY_MS = 120_000
/** Age after which a lock left by a crashed writer may be quarantined. */
export const ARXIV_SUBSCRIPTION_LOCK_STALE_MS = 5 * 60_000

/** Remove one stale lock without deleting a lock a later writer may own. */
async function recoverStaleArxivSubscriptionLock(filename: string): Promise<void> {
  const lockPath = `${filename}.lock`
  let stats
  try {
    stats = await lstat(lockPath)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  if (Date.now() - stats.mtimeMs < ARXIV_SUBSCRIPTION_LOCK_STALE_MS) return

  // Rename first so a lock created after the rename remains visible at the
  // canonical path; only the quarantined orphan is removed below.
  const quarantinePath = `${lockPath}.stale-${process.pid}-${Date.now()}`
  try {
    await rename(lockPath, quarantinePath)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  await rm(quarantinePath, { force: true })
}

/** Run one subscription-file mutation behind stale-lock recovery. */
export async function withArxivSubscriptionsFileLock<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const filename = join(workspaceDir, ARXIV_SUBSCRIPTIONS_FILE)
  await recoverStaleArxivSubscriptionLock(filename)
  return withFileLock(filename, operation)
}

/**
 * One persisted arXiv subscription. `seenIds` is the diff memory (newest
 * first, capped at {@link ARXIV_SUBSCRIPTION_SEEN_LIMIT}); `newEntryIds` and
 * `newEntries` accumulate what checks surfaced as new (same order, capped at
 * {@link ARXIV_SUBSCRIPTION_NEW_LIMIT}) — the ids are the bookkeeping, the
 * entries the cached details the panel renders without a re-fetch.
 */
export interface ArxivSubscriptionRecord {
  readonly id: string
  /** Free-text query matched against all arXiv fields. */
  readonly query: string
  /** ISO-8601 timestamp of the subscription's creation. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the last settled check; null until the first one. */
  readonly lastCheckedAt: string | null
  readonly seenIds: readonly string[]
  readonly newEntryIds: readonly string[]
  readonly newEntries: readonly ArxivEntry[]
}

/** Whether one parsed value reads as one entry of `newEntries`. */
function isArxivEntry(value: unknown): value is ArxivEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.title === 'string'
    && Array.isArray(entry.authors)
    && entry.authors.every(author => typeof author === 'string')
    && typeof entry.summary === 'string'
    && typeof entry.published === 'string'
    && typeof entry.url === 'string'
}

/** Whether one parsed value reads as a well-formed subscription record. */
function isArxivSubscriptionRecord(value: unknown): value is ArxivSubscriptionRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const stringArray = (field: unknown): boolean =>
    Array.isArray(field) && field.every(item => typeof item === 'string')
  return typeof record.id === 'string' && record.id !== ''
    && typeof record.query === 'string' && record.query !== ''
    && typeof record.createdAt === 'string'
    && (typeof record.lastCheckedAt === 'string' || record.lastCheckedAt === null)
    && stringArray(record.seenIds)
    && stringArray(record.newEntryIds)
    && Array.isArray(record.newEntries)
    && record.newEntries.every(isArxivEntry)
}

/**
 * Load the persisted subscription list. A missing or malformed file reads as
 * empty (fail-open, like the snapshot listing); structurally invalid records
 * are dropped one by one.
 * @param workspaceDir - absolute research workspace root.
 * @returns the records in file order (creation order).
 */
export async function loadArxivSubscriptions(workspaceDir: string): Promise<ArxivSubscriptionRecord[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(workspaceDir, ARXIV_SUBSCRIPTIONS_FILE), 'utf8'))
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return []
    throw error
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isArxivSubscriptionRecord)
}

/**
 * Atomically replace the persisted subscription list.
 * @param workspaceDir - absolute research workspace root.
 * @param subscriptions - the full list to persist.
 */
export async function saveArxivSubscriptions(
  workspaceDir: string,
  subscriptions: readonly ArxivSubscriptionRecord[],
): Promise<void> {
  await writeFileAtomic(
    join(workspaceDir, ARXIV_SUBSCRIPTIONS_FILE),
    JSON.stringify(subscriptions, null, 2),
    { mode: 0o666 },
  )
}

/**
 * Fold one fetch's entries into one subscription's diff state. The FIRST
 * check of a subscription only seeds the baseline (`seenIds`, no new
 * entries) — "new" means surfaced after subscribing, not the whole current
 * backlog. Later checks diff against `seenIds`, append the freshly surfaced
 * entries to the accumulated new lists, and trim both caps.
 * @param record - the stored record.
 * @param entries - the check's fetched entries, newest first.
 * @param now - the check instant (stamped onto `lastCheckedAt`).
 * @returns the updated record plus the entries this check surfaced as new.
 */
export function foldArxivSubscriptionCheck(
  record: ArxivSubscriptionRecord,
  entries: readonly ArxivEntry[],
  now: Date,
): { readonly record: ArxivSubscriptionRecord; readonly added: readonly ArxivEntry[] } {
  const seen = new Set(record.seenIds)
  const baseline = record.lastCheckedAt === null
  const added = baseline ? [] : entries.filter(entry => !seen.has(entry.id))
  const seenIds = [...new Set([...entries.map(entry => entry.id), ...record.seenIds])]
    .slice(0, ARXIV_SUBSCRIPTION_SEEN_LIMIT)
  // Newest first, so both caps trim the oldest entries.
  const newEntryIds = [...new Set([...added.map(entry => entry.id), ...record.newEntryIds])]
    .slice(0, ARXIV_SUBSCRIPTION_NEW_LIMIT)
  const kept = new Set(newEntryIds)
  const newEntries = [
    ...added,
    ...record.newEntries.filter(entry => !added.some(fresh => fresh.id === entry.id)),
  ].filter(entry => kept.has(entry.id))
  return {
    record: {
      ...record,
      lastCheckedAt: now.toISOString(),
      seenIds,
      newEntryIds,
      newEntries,
    },
    added: Object.freeze(added),
  }
}

/** One subscription's outcome of one {@link runArxivSubscriptionCheck} run. */
export interface ArxivSubscriptionCheckOutcome {
  /** The post-check record (the pre-check one when the fetch failed). */
  readonly record: ArxivSubscriptionRecord
  /** The entries THIS run surfaced as new (empty on the baseline seeding). */
  readonly added: readonly ArxivEntry[]
  /** The fetch failure, or null when this subscription checked clean. */
  readonly error: unknown
}

/** Injectable knobs of one {@link runArxivSubscriptionCheck} run. */
export interface ArxivSubscriptionCheckOptions {
  /** Check only the subscription with this id; absent checks all. */
  readonly id?: string
  /** The check instant stamped onto settled records (test injection). */
  readonly now?: Date
  /** Gap between two subscriptions' requests (default {@link ARXIV_SUBSCRIPTION_GAP_MS}). */
  readonly gapMs?: number
  /** Per-request timeout (default {@link ARXIV_SUBSCRIPTION_FETCH_TIMEOUT_MS}). */
  readonly timeoutMs?: number
  /** Search implementation (test injection; default {@link fetchArxivSearch}). */
  readonly fetchSearch?: typeof fetchArxivSearch
  /** Sleep implementation of the inter-request gap (test injection). */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Check subscriptions for new papers: the selected records (one via `id`,
 * else all) are fetched SERIALLY, newest submissions first, with the polite
 * gap between requests. One subscription's failure never fails the run — its
 * record stays untouched and its outcome carries the error. The updated
 * list is persisted once at the end (only when at least one record changed).
 * @param workspaceDir - absolute research workspace root.
 * @param options - selection and injection knobs.
 * @returns one outcome per selected subscription, in list order; undefined
 * when `id` selected an unknown subscription.
 */
const activeChecks = new Map<string, Promise<readonly ArxivSubscriptionCheckOutcome[] | undefined>>()

/** Serialize same-target in-process checks while the file lock covers other processes. */
export async function runArxivSubscriptionCheck(
  workspaceDir: string,
  options: ArxivSubscriptionCheckOptions = {},
): Promise<readonly ArxivSubscriptionCheckOutcome[] | undefined> {
  // Merge only SAME-target calls: a full run and a single-subscription run
  // differ in what they return (and in what the panel shows), so folding one
  // into the other would hand back the wrong shape. The file lock inside the
  // save path still serializes their persistence.
  const key = `${workspaceDir}${options.id ?? ''}`
  const existing = activeChecks.get(key)
  if (existing !== undefined) return existing
  const run = runArxivSubscriptionCheckUnlocked(workspaceDir, options)
  activeChecks.set(key, run)
  try {
    return await run
  } finally {
    if (activeChecks.get(key) === run) activeChecks.delete(key)
  }
}

/** Execute one check after the workspace-level in-process gate is acquired. */
async function runArxivSubscriptionCheckUnlocked(
  workspaceDir: string,
  options: ArxivSubscriptionCheckOptions,
): Promise<readonly ArxivSubscriptionCheckOutcome[] | undefined> {
  const fetchSearch = options.fetchSearch ?? fetchArxivSearch
  const sleep = options.sleep ?? (async (ms: number): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
  const gapMs = options.gapMs ?? ARXIV_SUBSCRIPTION_GAP_MS
  const timeoutMs = options.timeoutMs ?? ARXIV_SUBSCRIPTION_FETCH_TIMEOUT_MS
  const now = options.now ?? new Date()
  const subscriptions = await loadArxivSubscriptions(workspaceDir)
  const selected = options.id === undefined
    ? subscriptions
    : subscriptions.filter(record => record.id === options.id)
  if (options.id !== undefined && selected.length === 0) return undefined
  const outcomes: ArxivSubscriptionCheckOutcome[] = []
  let fetches = 0
  for (const record of selected) {
    if (fetches > 0 && gapMs > 0) await sleep(gapMs)
    fetches += 1
    try {
      const entries = await fetchSearch(
        record.query,
        ARXIV_SUBSCRIPTION_CHECK_RESULTS,
        AbortSignal.timeout(timeoutMs),
        { sortBySubmittedDate: true },
      )
      const folded = foldArxivSubscriptionCheck(record, entries, now)
      outcomes.push({ record: folded.record, added: folded.added, error: null })
    } catch (error) {
      outcomes.push({ record, added: Object.freeze([]), error })
    }
  }
  if (outcomes.some(outcome => outcome.error === null)) {
    await withArxivSubscriptionsFileLock(workspaceDir, async () => {
      const updates = new Map(outcomes
        .filter((outcome): outcome is ArxivSubscriptionCheckOutcome & { readonly error: null } => outcome.error === null)
        .map(outcome => [outcome.record.id, outcome.record]))
      const latest = await loadArxivSubscriptions(workspaceDir)
      await saveArxivSubscriptions(workspaceDir, latest.map(record => {
        const updated = updates.get(record.id)
        return updated === undefined ? record : mergeSubscriptionRecord(record, updated)
      }))
    })
  }
  return Object.freeze(outcomes)
}

/** Merge two concurrent checks without discarding entries discovered by either. */
function mergeSubscriptionRecord(current: ArxivSubscriptionRecord, updated: ArxivSubscriptionRecord): ArxivSubscriptionRecord {
  const seenIds = [...new Set([...updated.seenIds, ...current.seenIds])].slice(0, ARXIV_SUBSCRIPTION_SEEN_LIMIT)
  const newEntryIds = [...new Set([...updated.newEntryIds, ...current.newEntryIds])].slice(0, ARXIV_SUBSCRIPTION_NEW_LIMIT)
  const newEntries = [...new Map([...updated.newEntries, ...current.newEntries].map(entry => [entry.id, entry])).values()]
    .filter(entry => newEntryIds.includes(entry.id))
    .slice(0, ARXIV_SUBSCRIPTION_NEW_LIMIT)
  return {
    ...current,
    ...updated,
    seenIds: Object.freeze(seenIds),
    newEntryIds: Object.freeze(newEntryIds),
    newEntries: Object.freeze(newEntries),
  }
}

/** Options for {@link startArxivSubscriptionLoop}. */
export interface ArxivSubscriptionLoopOptions {
  /** The absolute research workspace root. */
  readonly workspaceDir: string
  /** Check cadence in milliseconds (>= 1). */
  readonly intervalMs: number
  /** Delay of the FIRST run (default {@link ARXIV_SUBSCRIPTION_FIRST_DELAY_MS}). */
  readonly firstDelayMs?: number
  /** Shared scheduled-task health book (#223); every pass is recorded. */
  readonly health: TaskHealthRegistry
  /** Failure sink: called when a whole run rejects (a per-subscription fetch failure never reaches here); the loop keeps going. */
  readonly onError: (error: unknown) => void
}

/** Health-book key of the arXiv-subscription loop. */
export const ARXIV_SUBSCRIPTION_TASK = 'arxiv-subscriptions'

/**
 * Start the scheduled subscription check: the first run after `firstDelayMs`
 * (startup stays fast), then every `intervalMs` after the previous run
 * settles, stretched by the shared backoff after consecutive failures (#223).
 * The timer is unref'd so it never holds the process open. A run over an
 * empty subscription list is one cheap file read — no request ever fires.
 * @param options - see {@link ArxivSubscriptionLoopOptions}.
 * @returns dispose: clears the pending timer (an in-flight run finishes).
 */
export function startArxivSubscriptionLoop(options: ArxivSubscriptionLoopOptions): () => void {
  return startScheduledLoop({
    name: ARXIV_SUBSCRIPTION_TASK,
    health: options.health,
    intervalMs: options.intervalMs,
    firstDelayMs: options.firstDelayMs ?? ARXIV_SUBSCRIPTION_FIRST_DELAY_MS,
    run: () => runArxivSubscriptionCheck(options.workspaceDir),
    onError: options.onError,
  })
}
