/**
 * ProjectAdmin domain module: the panel-driven project lifecycle — create,
 * rename, delete (#160). Projects are plain rows of the wiki's `projects`
 * table, so the panel manages them without any host-side (dsh) operation.
 * Delete is a confirmed cascade: the project row plus its experiments,
 * figure metadata, venue watches, and project-registered ideas go; papers
 * are UNLINKED (a paper can serve several projects) with the project's
 * relevance verdicts dropped; the generated-decks directory is removed from
 * disk; the ledger, servers, jobs, and claims stay (audit trail and global
 * resources). Thin forwarding of the `project-admin.*` Remote methods lives
 * in `service.ts`.
 * @module dsh-mimir/src/services/project-admin
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidProjectId } from '../project-id.ts'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import { MEETINGS_DIR_NAME } from './meeting.ts'
import type { WikiAdminDeps } from './wiki-admin.ts'
import { projectView } from './wiki-admin.ts'
import type {
  ProjectRecord,
  ResearchCreateProjectResult,
  ResearchDeleteProjectResult,
  ResearchRenameProjectResult,
} from '../types.ts'
import { rejected, success } from './common.ts'

/** Title length cap of one project (a guard, not a tunable). */
export const PROJECT_TITLE_MAX_LENGTH = 200

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
 * matches {@link createProject}.
 * @param deps - open wiki domain.
 * @param request - the project id and the new title.
 * @returns the updated project row.
 */
export async function renameProject(
  deps: WikiAdminDeps,
  request: { projectId: string; title: string },
): Promise<ResearchRenameProjectResult> {
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
}

/**
 * Delete one project and its project-scoped data. Destructive, so the
 * request must carry `confirm: true` (the same gate as the destructive wiki
 * import). The id is re-validated against the path whitelist before the
 * decks directory is joined — a legacy bad row must not reach `rm`. Cascade:
 * experiments, figure metadata rows, venue watches, and project-registered
 * ideas are deleted; papers are unlinked (never deleted — one paper can
 * serve several projects) and their relevance verdicts for this project
 * drop; `meetings/<projectId>/` is removed from disk (best-effort — a
 * missing directory reads as already gone); the ledger, servers, jobs, and
 * claims are deliberately untouched (audit trail and project-independent
 * resources).
 * @param deps - open wiki domain and workspace root.
 * @param request - the project id plus the confirmation flag.
 * @returns the per-kind removal counts.
 */
export async function deleteProject(
  deps: WikiAdminDeps,
  request: { projectId: string; confirm?: boolean },
): Promise<ResearchDeleteProjectResult> {
  const table = deps.domain.table('projects')
  const record = table.get(request.projectId)
  if (record === undefined) return rejected({ code: 'project-not-found', projectId: request.projectId })
  if (request.confirm !== true) {
    return rejected({ code: 'invalid-input', message: 'deleting a project requires confirm: true' })
  }
  // The id keys the meetings-directory join below; the durable schema keeps
  // it an unconstrained string, so the check happens at use (same rule as
  // the import path).
  if (!isValidProjectId(record.id)) {
    return rejected({ code: 'invalid-path', path: record.id })
  }

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
  // Papers stay; only the link and this project's verdict are dropped.
  let paperLinks = 0
  const papersTable = deps.domain.table('papers')
  for (const [key, row] of [...papersTable.entries()]) {
    const linked = row.projectIds.includes(record.id)
    const scored = row.relevance?.[record.id] !== undefined
    if (!linked && !scored) continue
    const relevance = Object.fromEntries(
      Object.entries(row.relevance ?? {}).filter(([projectId]) => projectId !== record.id),
    )
    await papersTable.put(key, {
      ...row,
      projectIds: row.projectIds.filter(projectId => projectId !== record.id),
      ...(Object.keys(relevance).length > 0 ? { relevance } : {}),
    })
    paperLinks += 1
  }
  await table.delete(record.id)

  let meetingsRemoved = false
  try {
    await rm(join(deps.workspaceDir, MEETINGS_DIR_NAME, record.id), { recursive: true })
    meetingsRemoved = true
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }

  const removed = { experiments, figures, venueWatches, ideas, paperLinks, meetingsRemoved }
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'project.deleted',
    refs: { projectId: record.id },
    payload: { title: record.title, destructive: true, ...removed },
  })
  return success({ projectId: record.id, removed })
}
