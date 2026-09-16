/**
 * WikiAdmin domain module: the wiki's top-level list, the snapshot
 * export/import (backup/migration), and the scheduled-backup status line.
 * Thin forwarding of the `wiki-admin.*` Remote namespace lives in
 * `service.ts`.
 * @module dsh-mimir/src/services/wiki-admin
 */

import { access, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isValidArxivId } from '../arxiv-id.ts'
import { isValidProjectId } from '../project-id.ts'
import { isBackupFileName } from '../backup.ts'
import {
  buildWikiSnapshot,
  snapshotEnvelopeError,
  snapshotTables,
  tableRowsError,
  WIKI_TABLE_KEY,
  WIKI_TABLE_NAMES,
} from '../wiki-snapshot.ts'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type {
  ResearchExportWikiResult,
  ResearchImportWikiMode,
  ResearchImportWikiResult,
  ResearchListBackupsResult,
  ResearchListProjectsResult,
  ResearchProjectView,
  ResearchWikiSnapshot,
  ResearchWikiTableName,
} from '../types.ts'
import { rejected, success } from './common.ts'

/**
 * Everything the WikiAdmin domain functions need from the service scope.
 * The `backup` knobs are inlined (rather than referencing `service.ts`'s
 * config type) so this module never imports the facade — no cycle.
 */
export interface WikiAdminDeps {
  readonly domain: ResearchWikiDomain
  readonly workspaceDir: string
  readonly backup?: {
    readonly enabled: boolean
    readonly intervalMinutes: number
    readonly keep: number
    readonly dir: string
  }
}

/** Durable undo record for an interrupted destructive wiki import. */
export const WIKI_IMPORT_RECOVERY_FILE = '.wiki-import-recovery.json'

type WikiTable = {
  get: (key: string) => unknown
  put: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<boolean>
  entries: () => IterableIterator<[string, unknown]>
}

/** Replace exactly the tables carried by one already-validated snapshot. */
async function replaceWiki(
  domain: ResearchWikiDomain,
  snapshot: ResearchWikiSnapshot,
  skipUnsafeIds: boolean,
): Promise<Record<ResearchWikiTableName, number>> {
  const imported: Record<ResearchWikiTableName, number> = {
    papers: 0, ideas: 0, claims: 0, projects: 0, experiments: 0, servers: 0, figures: 0, events: 0,
  }
  // Queue the whole replacement synchronously: a write already queued wins
  // before replace; one queued after this batch wins after replace.
  const writes: Promise<unknown>[] = []
  for (const name of snapshotTables(snapshot)) {
    const table = domain.table(name) as WikiTable
    for (const [key] of [...table.entries()]) writes.push(table.delete(key))
    const keyField = WIKI_TABLE_KEY[name]
    for (const row of snapshot.tables[name]) {
      const key = (row as unknown as Record<string, unknown>)[keyField] as string
      if (skipUnsafeIds && name === 'papers' && !isValidArxivId(key)) continue
      if (skipUnsafeIds && name === 'projects' && !isValidProjectId(key)) continue
      writes.push(table.put(key, row))
      imported[name] += 1
    }
  }
  const settled = await Promise.allSettled(writes)
  const failed = settled.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
  return imported
}

/** Validate a recovery snapshot read from disk before it can touch the domain. */
function validateSnapshot(snapshot: ResearchWikiSnapshot): void {
  const envelopeError = snapshotEnvelopeError(snapshot)
  if (envelopeError !== null) throw new Error(`invalid wiki import recovery: ${envelopeError}`)
  for (const name of snapshotTables(snapshot)) {
    const rowError = tableRowsError(name, snapshot.tables[name])
    if (rowError !== null) throw new Error(`invalid wiki import recovery: ${rowError}`)
  }
}

/** Restore and remove a pending destructive-import undo record, when present. */
export async function recoverPendingWikiImport(deps: WikiAdminDeps): Promise<void> {
  const path = join(deps.workspaceDir, WIKI_IMPORT_RECOVERY_FILE)
  try {
    await access(path)
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return
    throw error
  }
  await withFileLock(path, async () => {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return
      throw error
    }
    const snapshot = JSON.parse(text) as ResearchWikiSnapshot
    validateSnapshot(snapshot)
    await replaceWiki(deps.domain, snapshot, false)
    await unlink(path)
  })
}

/** Project one wiki record into the panel's row shape. */
function projectView(record: {
  id: string
  title: string
  stage: ResearchProjectView['stage']
  paperDir?: string | undefined
  venue?: ResearchProjectView['venue']
  reviewRounds: number
  artifacts: readonly string[]
  updatedAt: string
}): ResearchProjectView {
  return Object.freeze({
    id: record.id,
    title: record.title,
    stage: record.stage,
    // Absent, never `undefined`: an explicit undefined key trips the
    // gateway's JSON boundary validation and fails the whole list call.
    ...(record.paperDir === undefined ? {} : { paperDir: record.paperDir }),
    ...(record.venue === undefined ? {} : { venue: record.venue }),
    reviewRounds: record.reviewRounds,
    artifacts: Object.freeze([...record.artifacts]),
    updatedAt: record.updatedAt,
  })
}

/**
 * List every wiki project, most recently updated first.
 * @param deps - open wiki domain.
 * @returns the project rows for the panel's list.
 */
export function listProjects(deps: WikiAdminDeps): Promise<ResearchListProjectsResult> {
  const projects = [...deps.domain.table('projects').entries()]
    .map(([, record]) => projectView(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return Promise.resolve(success({ projects: Object.freeze(projects) }))
}

/**
 * Export the whole wiki as one snapshot: every record of all seven tables
 * plus the whole `events` ledger under the format envelope (backup/
 * migration). The ledger travels with the wiki because every CBE organ is a
 * pure fold over it — a snapshot without it would restore the library and
 * silently zero the researcher's whole cognitive layer.
 * @param deps - open wiki domain.
 * @returns the snapshot; the table arrays carry each record with its
 * primary-key field (`arxivId`/`id`).
 */
export async function exportWiki(deps: WikiAdminDeps): Promise<ResearchExportWikiResult> {
  const snapshot = buildWikiSnapshot(deps.domain)
  const tables = Object.fromEntries(WIKI_TABLE_NAMES.map(name => [name, snapshot.tables[name].length]))
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'data.wiki.exported',
    refs: {},
    payload: { tables },
  })
  return success({ snapshot })
}

/**
 * Import one wiki snapshot. Every row is validated against its table's
 * schema BEFORE any write, so a bad snapshot changes nothing. `merge`
 * upserts only absent primary keys — existing records are never
 * overwritten, just counted as skipped (conservative first). `replace`
 * wipes the tables the snapshot carries first, so it additionally requires
 * `confirmReplace: true` (`invalid-input` otherwise). Replace is an exclusive
 * maintenance operation: writes issued while it is running may be superseded
 * by the replacement or a failure rollback.
 * @param deps - open wiki domain.
 * @param request - the parsed snapshot JSON, the mode, and the replace
 * confirmation flag. A legacy v2 snapshot (seven tables, no `events`) is
 * still accepted: it restores no ledger and — even in `replace` mode — never
 * wipes the ledger it says nothing about.
 * @returns per-table imported/skipped row counts.
 */
export async function importWiki(
  deps: WikiAdminDeps,
  request: {
    snapshot: ResearchWikiSnapshot
    mode: ResearchImportWikiMode
    confirmReplace?: boolean
  },
): Promise<ResearchImportWikiResult> {
  // Widened to string so the runtime guard is not linted away: remote
  // callers bypass the ResearchImportWikiMode type.
  const rawMode: string = request.mode
  if (rawMode !== 'merge' && rawMode !== 'replace') {
    return rejected({ code: 'invalid-input', message: `unknown import mode: ${rawMode}` })
  }
  if (request.mode === 'replace' && request.confirmReplace !== true) {
    return rejected({ code: 'invalid-input', message: 'replace mode requires confirmReplace: true' })
  }
  const envelopeError = snapshotEnvelopeError(request.snapshot)
  if (envelopeError !== null) return rejected({ code: 'invalid-input', message: envelopeError })
  const snapshot = request.snapshot
  const names = snapshotTables(snapshot)
  for (const name of names) {
    const rowError = tableRowsError(name, snapshot.tables[name])
    if (rowError !== null) return rejected({ code: 'invalid-input', message: rowError })
  }
  const zeroCounts = (): Record<ResearchWikiTableName, number> => ({
    papers: 0, ideas: 0, claims: 0, projects: 0, experiments: 0, servers: 0, figures: 0, events: 0,
  })
  const imported = zeroCounts()
  const skipped = zeroCounts()
  if (request.mode === 'replace') {
    const path = join(deps.workspaceDir, WIKI_IMPORT_RECOVERY_FILE)
    await mkdir(deps.workspaceDir, { recursive: true })
    await withFileLock(path, async () => {
      await writeFileAtomic(path, JSON.stringify(buildWikiSnapshot(deps.domain)), { mode: 0o600 })
      try {
        Object.assign(imported, await replaceWiki(deps.domain, snapshot, true))
        await unlink(path)
      } catch (error) {
        try {
          const recovery = JSON.parse(await readFile(path, 'utf8')) as ResearchWikiSnapshot
          validateSnapshot(recovery)
          await replaceWiki(deps.domain, recovery, false)
          await unlink(path)
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], 'wiki import failed and recovery is pending')
        }
        throw error
      }
    })
  }
  for (const name of names) {
    const table = deps.domain.table(name) as WikiTable
    const keyField = WIKI_TABLE_KEY[name]
    if (request.mode === 'replace') {
      skipped[name] = snapshot.tables[name].length - imported[name]
      continue
    }
    for (const row of snapshot.tables[name]) {
      const key = (row as unknown as Record<string, unknown>)[keyField] as string
      if (request.mode === 'merge' && table.get(key) !== undefined) {
        skipped[name] += 1
        continue
      }
      // The durable paper schema no longer hard-refines the id (a legacy bad
      // row must not abort the domain open), so the import validates
      // explicitly: a snapshot paper with a path-unsafe id is skipped, not
      // written.
      if (name === 'papers' && !isValidArxivId(key)) {
        skipped[name] += 1
        continue
      }
      // Same rule for projects: the id joins `meetings/<projectId>/`, so a
      // snapshot row carrying `../../x` would let a later deck request escape
      // the workspace. Skipped rather than written, as above.
      if (name === 'projects' && !isValidProjectId(key)) {
        skipped[name] += 1
        continue
      }
      await table.put(key, row)
      imported[name] += 1
    }
  }
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'data.wiki.imported',
    refs: {},
    payload: { mode: request.mode, imported, skipped, destructive: request.mode === 'replace' },
  })
  return success({ imported, skipped })
}

/**
 * The scheduled-backup status line for the overview's data section: the
 * resolved knobs plus how many backups are on disk (and the newest one's
 * name). A missing/unreadable directory reads as zero backups; a service
 * built without backup knobs reports `enabled: false`.
 * @param deps - open wiki domain plus the resolved backup knobs.
 * @returns the backup status view.
 */
export async function listBackups(deps: WikiAdminDeps): Promise<ResearchListBackupsResult> {
  if (deps.backup === undefined || !deps.backup.enabled) {
    return success({
      backup: { enabled: false, intervalMinutes: 0, keep: 0, count: 0, latestName: null },
    })
  }
  const names = (await readdir(deps.backup.dir).catch(() => [] as string[]))
    .filter(isBackupFileName)
    .sort()
  return success({
    backup: {
      enabled: true,
      intervalMinutes: deps.backup.intervalMinutes,
      keep: deps.backup.keep,
      count: names.length,
      latestName: names.at(-1) ?? null,
    },
  })
}
