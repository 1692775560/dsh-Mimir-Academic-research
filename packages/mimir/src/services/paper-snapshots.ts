/**
 * Paper-snapshot domain: list/read/revert the per-project compile snapshots
 * stored under `<workspaceDir>/snapshots/<projectId>/`, plus the capture hook
 * `compile` runs after a successful build. Snapshots are pure filesystem
 * storage — the wiki domain schema stays untouched. Thin forwarding of the
 * `paper.*` snapshot Remote methods lives in `service.ts`.
 * @module dsh-mimir/src/services/paper-snapshots
 */

import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isNotFound, resolvePaperDirReal, saveTextFileOptimistic } from '../paper-source.ts'
import {
  capturePaperSnapshot,
  isValidSnapshotId,
  listPaperSnapshots as listSnapshotManifests,
  readPaperSnapshot,
  resolveSnapshotsRoot,
} from '../paper-snapshots.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type {
  ResearchFailure,
  ResearchPaperSnapshotResult,
  ResearchPaperSnapshotsResult,
  ResearchRejected,
  ResearchRevertPaperSnapshotResult,
} from '../types.ts'
import { rejected, success } from './common.ts'

/** Everything the paper-snapshot domain functions need from the service scope. */
export interface PaperSnapshotDeps {
  readonly workspaceDir: string
  readonly domain: ResearchWikiDomain
}

/**
 * The filename of the paper's main source, the revert's conflict anchor and
 * the one file a revert requires a snapshot to carry.
 */
const MAIN_TEX = 'main.tex'

/**
 * Resolve the snapshots root of one addressed project, or the rejection to
 * return: `project-not-found` for an unknown id, `invalid-input` for an id
 * that would escape `<workspaceDir>/snapshots`. The failure branch is typed
 * as the raw rejection so every snapshot method can return it as-is.
 */
function snapshotsRootOf(
  deps: PaperSnapshotDeps,
  projectId: string,
): { readonly root: string } | { readonly failure: ResearchRejected<ResearchFailure> } {
  const record = deps.domain.table('projects').get(projectId)
  if (record === undefined) {
    return { failure: rejected({ code: 'project-not-found', projectId }) }
  }
  const root = resolveSnapshotsRoot(deps.workspaceDir, projectId)
  if (root === undefined) {
    return { failure: rejected({ code: 'invalid-input', message: `project id '${projectId}' escapes the snapshots root` }) }
  }
  return { root }
}

/**
 * Capture the addressed paper directory's sources as one snapshot of the
 * given project — the post-successful-compile hook. Best-effort by contract:
 * the caller (`compile`) swallows failures so a snapshot I/O problem never
 * fails the compile it rides on.
 * @param deps - workspace root and open wiki domain.
 * @param projectId - the compiled project (snapshots are per project; the
 * unkeyed compile slot never snapshots).
 * @param paperDir - the already-resolved absolute paper directory.
 */
export async function captureCompileSnapshot(
  deps: PaperSnapshotDeps,
  projectId: string,
  paperDir: string,
): Promise<void> {
  const root = resolveSnapshotsRoot(deps.workspaceDir, projectId)
  if (root === undefined) return
  await capturePaperSnapshot(root, paperDir)
}

/**
 * List one project's snapshots, newest first.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project.
 * @returns the snapshot views (id, capture time, file list, total size), or
 * `project-not-found`/`invalid-input` for a bad address.
 */
export async function listPaperSnapshots(
  deps: PaperSnapshotDeps,
  request: { projectId: string },
): Promise<ResearchPaperSnapshotsResult> {
  const resolved = snapshotsRootOf(deps, request.projectId)
  if ('failure' in resolved) return resolved.failure
  const manifests = await listSnapshotManifests(resolved.root)
  return success({
    snapshots: Object.freeze(manifests.map(manifest => Object.freeze({
      id: manifest.id,
      createdAt: manifest.createdAt,
      files: Object.freeze(manifest.files.map(file => Object.freeze({ ...file }))),
      sizeBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    }))),
  })
}

/**
 * Read one snapshot's files with their content (the panel's diff source).
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project and the snapshot id.
 * @returns the snapshot's files, `snapshot-not-found` for an unknown or
 * malformed snapshot, `invalid-input` for a malformed id, or
 * `project-not-found`/`invalid-input` for a bad address.
 */
export async function getPaperSnapshot(
  deps: PaperSnapshotDeps,
  request: { projectId: string; id: string },
): Promise<ResearchPaperSnapshotResult> {
  const resolved = snapshotsRootOf(deps, request.projectId)
  if ('failure' in resolved) return resolved.failure
  if (!isValidSnapshotId(request.id)) {
    return rejected({ code: 'invalid-input', message: `malformed snapshot id '${request.id}'` })
  }
  const snapshot = await readPaperSnapshot(resolved.root, request.id)
  if (snapshot === undefined) return rejected({ code: 'snapshot-not-found', id: request.id })
  return success({ id: snapshot.id, files: Object.freeze(snapshot.files.map(file => Object.freeze({ ...file }))) })
}

/**
 * Write one snapshot's files back over the project's paper sources under the
 * same optimistic concurrency as `savePaperSource`: the commit only lands
 * when `main.tex`'s mtime still equals `baseMtimeMs`. The main source commits
 * first (inside its writer lock, preserving permission bits); the snapshot's
 * remaining `.tex`/`.bib` files follow, atomically, creating nested
 * directories as needed. A snapshot without `main.tex` cannot anchor the
 * conflict check and rejects with `invalid-input`.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the snapshot id, the mtime the
 * caller's view of `main.tex` is based on, and an optional explicit paper
 * directory (relative to the workspace) overriding the record's `paperDir`.
 * @returns the committed `main.tex` mtime, `project-not-found`,
 * `paper-not-found`, `invalid-dir`, `invalid-input`, `snapshot-not-found`, or
 * `conflict` carrying the mtime that displaced the base.
 */
export async function revertPaperSnapshot(
  deps: PaperSnapshotDeps,
  request: { projectId: string; id: string; baseMtimeMs: number; dir?: string | undefined },
): Promise<ResearchRevertPaperSnapshotResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const root = resolveSnapshotsRoot(deps.workspaceDir, request.projectId)
  if (root === undefined) {
    return rejected({ code: 'invalid-input', message: `project id '${request.projectId}' escapes the snapshots root` })
  }
  if (!isValidSnapshotId(request.id)) {
    return rejected({ code: 'invalid-input', message: `malformed snapshot id '${request.id}'` })
  }
  const dir = await resolvePaperDirReal(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const snapshot = await readPaperSnapshot(root, request.id)
  if (snapshot === undefined) return rejected({ code: 'snapshot-not-found', id: request.id })
  const main = snapshot.files.find(file => file.path === MAIN_TEX)
  if (main === undefined) {
    return rejected({ code: 'invalid-input', message: `snapshot '${request.id}' does not contain ${MAIN_TEX}` })
  }
  const outcome = await saveTextFileOptimistic(join(dir, MAIN_TEX), main.content, request.baseMtimeMs)
  if (outcome.kind === 'missing') return rejected({ code: 'paper-not-found' })
  if (outcome.kind === 'conflict') {
    return rejected({ code: 'conflict', currentMtimeMs: outcome.currentMtimeMs })
  }
  for (const file of snapshot.files) {
    if (file.path === MAIN_TEX) continue
    const target = join(dir, file.path)
    await mkdir(dirname(target), { recursive: true })
    const stats = await stat(target).catch((error: unknown) => {
      if (isNotFound(error)) return undefined
      throw error
    })
    await writeFileAtomic(target, file.content, { mode: stats === undefined ? 0o666 : stats.mode & 0o777 })
  }
  return success({ mtimeMs: outcome.mtimeMs })
}
