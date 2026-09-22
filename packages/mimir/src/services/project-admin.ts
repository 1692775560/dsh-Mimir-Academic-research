/**
 * ProjectAdmin domain module: the panel-driven project lifecycle — create,
 * rename, delete (#160). Projects are plain rows of the wiki's `projects`
 * table, so the panel manages them without any host-side (dsh) operation.
 * Delete is a confirmed cascade orchestrated as: disk first (the meeting
 * decks, and — only when it resolves inside `imported/` — the paper tree; a
 * non-ENOENT failure rejects the verb with NOTHING touched), then the table
 * rows (experiments, figure metadata, venue watches, project-registered
 * ideas), then the paper unlink pass under the per-paper mutation lock (a
 * paper can serve several projects, so papers are never deleted — only the
 * link and this project's relevance verdicts drop), then the project row and
 * the audit event. The whole run holds the per-project mutation lock, so a
 * `wiki_note` write aimed at the project lands before the cascade (and is
 * cleaned by it) or after it (and fails the existence check) — never inside
 * it. The ledger, servers, jobs, and claims stay (audit trail and global
 * resources). Thin forwarding of the `project-admin.*` Remote methods lives
 * in `service.ts`.
 * @module dsh-mimir/src/services/project-admin
 */

import { randomUUID } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { isValidProjectId } from '../project-id.ts'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import { MEETINGS_DIR_NAME } from './meeting.ts'
import type { WikiAdminDeps } from './wiki-admin.ts'
import { projectView } from './wiki-admin.ts'
import { withPaperMutationLock, withProjectMutationLock } from './mutation-locks.ts'
import type {
  ProjectRecord,
  ResearchCreateProjectResult,
  ResearchDeleteProjectResult,
  ResearchRenameProjectResult,
  ResearchResult,
} from '../types.ts'
import { rejected, success } from './common.ts'

/** Title length cap of one project (a guard, not a tunable). */
export const PROJECT_TITLE_MAX_LENGTH = 200

/** Workspace-relative root the import verb copies trees into; only a paper directory resolving inside it is removed with its project — anything else is the user's own tree and stays. */
const IMPORTED_ROOT_NAME = 'imported'

/** Trim and validate one project title; returns the cleaned title or null. */
function cleanTitle(title: string): string | null {
  const cleaned = title.trim()
  return cleaned.length > 0 && cleaned.length <= PROJECT_TITLE_MAX_LENGTH ? cleaned : null
}

/**
 * Create one project at the `idea` stage. The title is required (trimmed,
 * capped); everything else starts at its zero value.
 * @param deps - open wiki domain.
 * @param request - the project title.
 * @returns the created project row.
 */
export async function createProject(
  deps: WikiAdminDeps,
  request: { title: string },
): Promise<ResearchCreateProjectResult> {
  const title = cleanTitle(request.title)
  if (title === null) {
    return rejected({ code: 'invalid-input', message: `title must be 1-${String(PROJECT_TITLE_MAX_LENGTH)} non-blank characters` })
  }
  const record: ProjectRecord = {
    id: randomUUID(),
    title,
    stage: 'idea',
    artifacts: [],
    reviewRounds: 0,
    updatedAt: new Date().toISOString(),
  }
  await deps.domain.table('projects').put(record.id, record)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'project.created',
    refs: { projectId: record.id },
    payload: { title: record.title },
  })
  return success({ project: projectView(record) })
}

/**
 * Rename one project. An unknown id is `project-not-found`; the title rule
 * matches {@link createProject}. The write holds the per-project mutation
 * lock so it serializes against a delete of the same project.
 * @param deps - open wiki domain.
 * @param request - the project id and the new title.
 * @returns the updated project row.
 */
export async function renameProject(
  deps: WikiAdminDeps,
  request: { projectId: string; title: string },
): Promise<ResearchRenameProjectResult> {
  return withProjectMutationLock(request.projectId, async () => {
    const table = deps.domain.table('projects')
    const record = table.get(request.projectId)
    if (record === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
    const title = cleanTitle(request.title)
    if (title === null) {
      return rejected({ code: 'invalid-input', message: `title must be 1-${String(PROJECT_TITLE_MAX_LENGTH)} non-blank characters` })
    }
    const updated: ProjectRecord = { ...record, title, updatedAt: new Date().toISOString() }
    await table.put(record.id, updated)
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'project.renamed',
      refs: { projectId: record.id },
      payload: { from: record.title, to: title },
    })
    return success({ project: projectView(updated) })
  })
}

/** The disk phase's outcome (both flags false mean there was nothing on disk). */
interface ProjectDiskRemoval {
  readonly meetingsRemoved: boolean
  readonly paperDirRemoved: boolean
}

/**
 * Remove the project's on-disk data: the generated-decks directory, and the
 * paper directory ONLY when it resolves (lexically AND through realpath)
 * inside `<workspace>/imported/` — a directory anywhere else is the user's
 * own tree and is never touched. A missing directory reads as already gone;
 * any other failure rejects the whole verb with nothing touched.
 * @param deps - open wiki domain and workspace root.
 * @param record - the project row being deleted.
 * @returns the removal flags, or the rejection to return verbatim.
 */
async function removeProjectDirs(
  deps: WikiAdminDeps,
  record: ProjectRecord,
): Promise<ResearchResult<ProjectDiskRemoval>> {
  let meetingsRemoved = false
  try {
    await rm(join(deps.workspaceDir, MEETINGS_DIR_NAME, record.id), { recursive: true })
    meetingsRemoved = true
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') {
      return rejected({ code: 'operation-failed', message: `failed to remove the meeting decks: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  let paperDirRemoved = false
  if (record.paperDir !== undefined) {
    const importedRoot = resolve(deps.workspaceDir, IMPORTED_ROOT_NAME)
    const paperDir = resolve(deps.workspaceDir, record.paperDir)
    // Lexical gate first; the realpath gate settles it (a symlink pointing
    // out of `imported/` must not be followed into the user's tree).
    if (paperDir.startsWith(importedRoot + sep)) {
      const realImported = await realpath(importedRoot).catch(() => undefined)
      const realPaperDir = await realpath(paperDir).catch(() => undefined)
      // A vanished paper directory reads as already gone, like the decks.
      if (realImported !== undefined && realPaperDir !== undefined && realPaperDir.startsWith(realImported + sep)) {
        try {
          await rm(paperDir, { recursive: true })
          paperDirRemoved = true
        } catch (error) {
          if ((error as { code?: unknown }).code !== 'ENOENT') {
            return rejected({ code: 'operation-failed', message: `failed to remove the paper directory: ${error instanceof Error ? error.message : String(error)}` })
          }
        }
      }
    }
  }
  return success({ meetingsRemoved, paperDirRemoved })
}

/**
 * Delete one project and its project-scoped data. Destructive, so the
 * request must carry `confirm: true` (the same gate as the destructive wiki
 * import). The id is re-validated against the path whitelist before any
 * directory is joined — a legacy bad row must not reach `rm`. Orchestration:
 * the disk phase runs FIRST and a non-ENOENT failure rejects the verb with
 * nothing touched; the table cascade (experiments, figure metadata, venue
 * watches, project-registered ideas) and the paper unlink pass (under the
 * per-paper mutation lock) follow; the project row and the audit event close
 * the run. The ledger, servers, jobs, and claims are deliberately untouched
 * (audit trail and project-independent resources).
 * @param deps - open wiki domain and workspace root.
 * @param request - the project id plus the confirmation flag.
 * @returns the per-kind removal counts.
 */
export async function deleteProject(
  deps: WikiAdminDeps,
  request: { projectId: string; confirm?: boolean },
): Promise<ResearchDeleteProjectResult> {
  if (request.confirm !== true) {
    return rejected({ code: 'invalid-input', message: 'deleting a project requires confirm: true' })
  }
  return withProjectMutationLock(request.projectId, async () => {
    const table = deps.domain.table('projects')
    const record = table.get(request.projectId)
    if (record === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
    // The id keys the directory joins below; the durable schema keeps it an
    // unconstrained string, so the check happens at use (same rule as the
    // import path).
    if (!isValidProjectId(record.id)) {
      return rejected({ code: 'invalid-path', path: record.id })
    }

    const disk = await removeProjectDirs(deps, record)
    if (!disk.ok) return disk

    let experiments = 0
    for (const [key, row] of [...deps.domain.table('experiments').entries()]) {
      if (row.projectId !== record.id) continue
      await deps.domain.table('experiments').delete(key)
      experiments += 1
    }
    let figures = 0
    for (const [key, row] of [...deps.domain.table('figures').entries()]) {
      if (row.projectId !== record.id) continue
      await deps.domain.table('figures').delete(key)
      figures += 1
    }
    let venueWatches = 0
    for (const [key, row] of [...deps.domain.table('venue_watches').entries()]) {
      if (row.projectId !== record.id) continue
      await deps.domain.table('venue_watches').delete(key)
      venueWatches += 1
    }
    let ideas = 0
    for (const [key, row] of [...deps.domain.table('ideas').entries()]) {
      if (row.projectId !== record.id) continue
      await deps.domain.table('ideas').delete(key)
      ideas += 1
    }
    // Papers stay; only the link and this project's verdict are dropped. The
    // unlink rides the per-paper mutation lock so a concurrent panel update
    // of the same paper is never clobbered by a stale read here.
    let paperLinks = 0
    const papersTable = deps.domain.table('papers')
    for (const [key] of [...papersTable.entries()]) {
      const changed = await withPaperMutationLock(key, async () => {
        const row = papersTable.get(key)
        if (row === undefined) return false
        const linked = row.projectIds.includes(record.id)
        const scored = row.relevance?.[record.id] !== undefined
        if (!linked && !scored) return false
        const relevance = Object.fromEntries(
          Object.entries(row.relevance ?? {}).filter(([projectId]) => projectId !== record.id),
        )
        await papersTable.put(key, {
          ...row,
          projectIds: row.projectIds.filter(projectId => projectId !== record.id),
          ...(Object.keys(relevance).length > 0 ? { relevance } : {}),
        })
        return true
      })
      if (changed) paperLinks += 1
    }
    await table.delete(record.id)

    const removed = { experiments, figures, venueWatches, ideas, paperLinks, ...disk.value }
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'project.deleted',
      refs: { projectId: record.id },
      payload: { title: record.title, destructive: true, ...removed },
    })
    return success({ projectId: record.id, removed })
  })
}
