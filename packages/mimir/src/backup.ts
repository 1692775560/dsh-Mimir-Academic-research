/**
 * Scheduled wiki backup: the host-side timer that periodically snapshots the
 * wiki (the same envelope `exportWiki` emits) into `<workspaceDir>/<dir>` as
 * `mimir-wiki-YYYYMMDD-HHmmss.json` (UTC), then prunes the oldest files past
 * the keep cap. Writes are atomic (sibling temp + rename, via
 * `@deepseek-ai/dsh-atomic-write`); failures are reported through the
 * caller's `onError` and the loop keeps going — a backup must never take the
 * plugin down. The name/prune rules are pure and unit-tested; the loop is a
 * thin timer shell around `runWikiBackup`.
 * @module dsh-mimir/src/backup
 */

import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { buildWikiSnapshot, type WikiSnapshotSource } from './wiki-snapshot.ts'
import { startScheduledLoop, type TaskHealthRegistry } from './task-health.ts'

/** Backup filename prefix; only files matching it are pruned. */
export const WIKI_BACKUP_PREFIX = 'mimir-wiki-'
/** Backup filename suffix. */
export const WIKI_BACKUP_SUFFIX = '.json'

/** How long after plugin start the FIRST backup runs (keeps startup fast). */
export const WIKI_BACKUP_FIRST_DELAY_MS = 60_000

/**
 * The backup filename for one run: `mimir-wiki-YYYYMMDD-HHmmss.json`, UTC,
 * so lexicographic order is chronological order.
 * @param now - the run timestamp.
 * @returns the basename (no directory part).
 */
export function backupFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${WIKI_BACKUP_PREFIX}${stamp}${WIKI_BACKUP_SUFFIX}`
}

/** One backup file name passes the prefix/suffix filter. */
export function isBackupFileName(name: string): boolean {
  return name.startsWith(WIKI_BACKUP_PREFIX) && name.endsWith(WIKI_BACKUP_SUFFIX)
}

/**
 * Which of the given backup files to delete so at most `keep` survive: the
 * names sorted ascending (lexicographic = chronological), everything but the
 * newest `keep` drops.
 * @param names - backup file basenames (any order).
 * @param keep - how many of the newest to keep (>= 1).
 * @returns the basenames to delete, oldest first.
 */
export function pruneBackupNames(names: readonly string[], keep: number): readonly string[] {
  const sorted = [...names].filter(isBackupFileName).sort()
  return Object.freeze(sorted.slice(0, Math.max(0, sorted.length - keep)))
}

/**
 * Run one backup pass: write the snapshot atomically under `dir` (created on
 * demand), then delete the oldest backups past `keep`. A same-second rerun
 * overwrites its own file (the name is second-granular) — harmless.
 * @param domain - the open wiki domain.
 * @param dir - the absolute backup directory.
 * @param keep - how many of the newest backups to keep.
 * @param now - the run timestamp (injectable for tests).
 * @returns the full path of the written file.
 */
export async function runWikiBackup(
  domain: WikiSnapshotSource,
  dir: string,
  keep: number,
  now = new Date(),
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, backupFileName(now))
  const snapshot = buildWikiSnapshot(domain, now)
  await writeFileAtomic(filePath, JSON.stringify(snapshot, null, 2), { mode: 0o666 })
  for (const name of pruneBackupNames(await readdir(dir), keep)) {
    // A file already gone (concurrent prune, manual cleanup) is not an error.
    await unlink(join(dir, name)).catch(() => {})
  }
  return filePath
}

/** Options for {@link startWikiBackupLoop}. */
export interface WikiBackupLoopOptions {
  /** The open wiki domain. */
  readonly domain: WikiSnapshotSource
  /** The absolute backup directory. */
  readonly dir: string
  /** Backup cadence in milliseconds (>= 1). */
  readonly intervalMs: number
  /** How many of the newest backups to keep. */
  readonly keep: number
  /** Delay of the FIRST run in milliseconds (default {@link WIKI_BACKUP_FIRST_DELAY_MS}). */
  readonly firstDelayMs?: number
  /** Shared scheduled-task health book (#223); every pass is recorded. */
  readonly health: TaskHealthRegistry
  /** Failure sink: called with each pass's error; the loop keeps going. */
  readonly onError: (error: unknown) => void
  /** Backup implementation (test injection; defaults to {@link runWikiBackup}). */
  readonly runBackup?: typeof runWikiBackup
}

/** Health-book key of the wiki-backup loop. */
export const WIKI_BACKUP_TASK = 'wiki-backup'

/**
 * Start the backup loop: the first pass runs after `firstDelayMs` (startup
 * stays fast; the wiki rarely changes in the first minute), then every
 * `intervalMs` after the previous pass settles, stretched by the shared
 * backoff after consecutive failures (#223). The timer is unref'd so it never
 * holds the process open, and no pass outcome can stop the loop or the plugin.
 * @param options - see {@link WikiBackupLoopOptions}.
 * @returns dispose: clears the pending timer (an in-flight pass finishes).
 */
export function startWikiBackupLoop(options: WikiBackupLoopOptions): () => void {
  const runBackup = options.runBackup ?? runWikiBackup
  return startScheduledLoop({
    name: WIKI_BACKUP_TASK,
    health: options.health,
    intervalMs: options.intervalMs,
    firstDelayMs: options.firstDelayMs ?? WIKI_BACKUP_FIRST_DELAY_MS,
    run: () => runBackup(options.domain, options.dir, options.keep),
    onError: options.onError,
  })
}
