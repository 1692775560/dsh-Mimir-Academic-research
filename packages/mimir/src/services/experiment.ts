/**
 * Experiment domain module: experiment records CRUD, whitelisted workspace
 * artifact reads, and the figure list/delete flow (paper-directory image
 * files merged with the wiki's figures metadata table). Thin forwarding of
 * the `experiment.*` Remote namespace lives in `service.ts`.
 * @module dsh-mimir/src/services/experiment
 */

import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isArtifactName, isFigureFile, listPaperFigures, readWorkspaceArtifact } from '../artifacts.ts'
import { isNotFound, readPaperSourceUnlocked, resolvePaperDir } from '../paper-source.ts'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import { convertSvgFigure, svgConverterNames } from '../svg-convert.ts'
import type { SvgConversionDeps } from '../svg-convert.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type {
  ExperimentInput,
  ExperimentRecord,
  ResearchArtifactResult,
  ResearchConvertFigureResult,
  ResearchDeleteExperimentResult,
  ResearchDeleteFigureResult,
  ResearchExperimentsResult,
  ResearchFiguresResult,
  ResearchRenameFigureResult,
  ResearchSaveExperimentResult,
  ResearchSaveFigureResult,
  ResearchUpdateExperimentResult,
  ResearchUpdateFigureResult,
} from '../types.ts'
import { rejected, success } from './common.ts'

/** Everything the Experiment domain functions need from the service scope. */
export interface ExperimentDeps {
  readonly workspaceDir: string
  readonly domain: ResearchWikiDomain
  /** Probe/run overrides for the SVG conversion behind `convertFigure`; absent outside tests. */
  readonly svg?: SvgConversionDeps
}

/** Legal experiment statuses, for the runtime guard (remote callers bypass the type). */
const EXPERIMENT_STATUSES: readonly string[] = ['running', 'success', 'failed']

/** First invalid-input message for one experiment upsert payload, or null when valid. */
function validateExperimentInput(input: ExperimentInput): string | null {
  if (input.name.trim().length === 0) return 'name must be non-empty'
  // Widened to string so the runtime guard is not linted away.
  const rawStatus: string = input.status
  if (!EXPERIMENT_STATUSES.includes(rawStatus)) return `unknown status: ${rawStatus}`
  if (typeof input.metrics !== 'object' || input.metrics === null || Array.isArray(input.metrics)) {
    return 'metrics must be an object keyed by metric name'
  }
  for (const [key, value] of Object.entries(input.metrics)) {
    if (key.trim().length === 0) return 'metrics keys must be non-empty'
    if (typeof value !== 'number' && typeof value !== 'string') return `metrics.${key} must be a number or a string`
  }
  return null
}

/**
 * List experiment runs, filtered to one project when `projectId` is given.
 * @param deps - open wiki domain.
 * @param request - optional project filter; an unknown id is `project-not-found`.
 * @returns the experiment rows, most recently updated first.
 */
export function listExperiments(
  deps: ExperimentDeps,
  request: { projectId?: string },
): Promise<ResearchExperimentsResult> {
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return Promise.resolve(rejected({ code: 'project-not-found', projectId: request.projectId }))
  }
  const experiments = [...deps.domain.table('experiments').entries()]
    .map(([, record]) => record)
    .filter(record => request.projectId === undefined || record.projectId === request.projectId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return Promise.resolve(success({ experiments: Object.freeze(experiments) }))
}

/**
 * Delete one experiment record; an unknown id is `experiment-not-found`.
 * @param deps - open wiki domain.
 * @param request - the record id.
 * @returns the deleted id.
 */
export async function deleteExperiment(
  deps: ExperimentDeps,
  request: { id: string },
): Promise<ResearchDeleteExperimentResult> {
  const table = deps.domain.table('experiments')
  const removed = table.get(request.id)
  if (removed === undefined) {
    return rejected({ code: 'experiment-not-found', id: request.id })
  }
  await table.delete(request.id)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'experiments.deleted',
    refs: { experimentId: removed.id, projectId: removed.projectId },
    payload: { name: removed.name, destructive: true },
  })
  return success({ id: request.id })
}

/**
 * Upsert one experiment record (the panel's inline create/edit form).
 * `projectId` must name a wiki project (`project-not-found`); the name
 * must be non-empty, the status one of running/success/failed, and a
 * given `serverId` must name a remembered server (`invalid-input`). An
 * omitted `id` creates with a fresh `exp-` id; a given `id` must exist
 * (`experiment-not-found`) and replaces the mutable fields. An omitted
 * `logPath`/`serverId` is ABSENT from the record (never an
 * undefined-valued key — the gateway's JSON-safety pass rejects those),
 * and on update preserves the stored value (the form does not edit
 * logPath; clearing a server link goes through `updateExperiment`'s
 * null). Either way `updatedAt` refreshes — ExperimentRecord carries no
 * createdAt.
 * @param deps - open wiki domain.
 * @param request - the full-field payload.
 * @returns the stored record after the upsert.
 */
export async function saveExperiment(
  deps: ExperimentDeps,
  request: { experiment: ExperimentInput },
): Promise<ResearchSaveExperimentResult> {
  const input = request.experiment
  if (deps.domain.table('projects').get(input.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: input.projectId })
  }
  const invalid = validateExperimentInput(input)
  if (invalid !== null) return rejected({ code: 'invalid-input', message: invalid })
  if (input.serverId !== undefined
    && deps.domain.table('servers').get(input.serverId) === undefined) {
    return rejected({ code: 'invalid-input', message: `unknown server: ${input.serverId}` })
  }
  const table = deps.domain.table('experiments')
  const now = new Date().toISOString()
  if (input.id !== undefined) {
    const existing = table.get(input.id)
    if (existing === undefined) return rejected({ code: 'experiment-not-found', id: input.id })
    const next: ExperimentRecord = {
      ...existing,
      projectId: input.projectId,
      name: input.name,
      status: input.status,
      metrics: input.metrics,
      ...(input.logPath === undefined ? {} : { logPath: input.logPath }),
      ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
      updatedAt: now,
    }
    await table.put(input.id, next)
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'experiments.saved',
      refs: {
        experimentId: next.id, projectId: next.projectId,
        ...(next.serverId === undefined ? {} : { serverId: next.serverId }),
      },
      payload: { name: next.name, status: next.status, created: false, metricCount: Object.keys(next.metrics).length },
    })
    return success({ experiment: next })
  }
  const created: ExperimentRecord = {
    id: `exp-${Date.now().toString(36)}`,
    projectId: input.projectId,
    name: input.name,
    status: input.status,
    metrics: input.metrics,
    ...(input.logPath === undefined ? {} : { logPath: input.logPath }),
    ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
    updatedAt: now,
  }
  await table.put(created.id, created)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'experiments.saved',
    refs: {
      experimentId: created.id, projectId: created.projectId,
      ...(created.serverId === undefined ? {} : { serverId: created.serverId }),
    },
    payload: { name: created.name, status: created.status, created: true, metricCount: Object.keys(created.metrics).length },
  })
  return success({ experiment: created })
}

/**
 * Update one experiment record. Only the server link is mutable this round:
 * a string `serverId` must name a remembered server (`invalid-input`
 * otherwise), null clears the link, and an omitted field is a no-op. An
 * unknown experiment id is `experiment-not-found`.
 * @param deps - open wiki domain.
 * @param request - the record id plus the fields to replace.
 * @returns the stored record after the update.
 */
export async function updateExperiment(
  deps: ExperimentDeps,
  request: {
    id: string
    serverId?: string | null | undefined
  },
): Promise<ResearchUpdateExperimentResult> {
  const table = deps.domain.table('experiments')
  const existing = table.get(request.id)
  if (existing === undefined) {
    return rejected({ code: 'experiment-not-found', id: request.id })
  }
  if (request.serverId !== undefined && request.serverId !== null
    && deps.domain.table('servers').get(request.serverId) === undefined) {
    return rejected({ code: 'invalid-input', message: `unknown server: ${request.serverId}` })
  }
  let next: ExperimentRecord = existing
  if (request.serverId === null) {
    const { serverId: _dropped, ...rest } = existing
    next = rest
  } else if (request.serverId !== undefined) {
    next = { ...existing, serverId: request.serverId }
  }
  await table.put(request.id, next)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'experiments.server.relinked',
    refs: {
      experimentId: request.id,
      ...(request.serverId === null || request.serverId === undefined ? {} : { serverId: request.serverId }),
    },
    payload: { cleared: request.serverId === null },
  })
  return success({ experiment: next })
}

/**
 * Read one whitelisted markdown artifact from the workspace root. The name
 * whitelist makes traversal inexpressible — anything off the list is
 * `invalid-artifact`, a listed-but-absent file is `artifact-not-found`.
 * @param deps - workspace root and open wiki domain.
 * @param request - the owning project (bookkeeping/authorization) and the
 * artifact name.
 * @returns the artifact text with its mtime, or a business failure.
 */
export async function readArtifact(
  deps: ExperimentDeps,
  request: { projectId: string; name: string },
): Promise<ResearchArtifactResult> {
  if (deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  if (!isArtifactName(request.name)) {
    return rejected({ code: 'invalid-artifact', name: request.name })
  }
  const artifact = await readWorkspaceArtifact(deps.workspaceDir, request.name)
  if (artifact === undefined) return rejected({ code: 'artifact-not-found', name: request.name })
  return success({ name: request.name, content: artifact.content, mtimeMs: artifact.mtimeMs })
}

/**
 * List the image files of the addressed project's paper directory (top
 * level plus the `figures/` subdirectory), merged with the wiki's figures
 * metadata table (caption / linked experiment, keyed `<projectId>:<relPath>`).
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, plus an optional explicit paper
 * directory (relative to the workspace) overriding the record's `paperDir`.
 * @returns the figure entries, `project-not-found`, `invalid-dir`, or
 * `paper-not-found` when the paper directory does not exist.
 */
export async function listFigures(
  deps: ExperimentDeps,
  request: { projectId: string; dir?: string | undefined },
): Promise<ResearchFiguresResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  try {
    const stats = await stat(dir)
    if (!stats.isDirectory()) return rejected({ code: 'paper-not-found' })
  } catch (error) {
    if (isNotFound(error)) return rejected({ code: 'paper-not-found' })
    throw error
  }
  const meta = deps.domain.table('figures')
  const figures = (await listPaperFigures(dir)).map((entry) => {
    const saved = meta.get(`${request.projectId}:${entry.relPath}`)
    return saved === undefined
      ? entry
      : {
        ...entry,
        ...(saved.caption === '' ? {} : { caption: saved.caption }),
        ...(saved.experimentId === undefined ? {} : { experimentId: saved.experimentId }),
      }
  })
  return success({ figures: Object.freeze(figures) })
}

/**
 * Delete one figure file of the addressed project's paper directory. The
 * path must stay inside the paper directory and carry a servable figure
 * extension — anything else is `invalid-path`, a listed-but-absent file is
 * `figure-not-found`.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the paper-directory-relative figure
 * path, and an optional explicit paper directory (relative to the workspace)
 * overriding the record's `paperDir`.
 * @returns the deleted path, or a business failure.
 */
export async function deleteFigure(
  deps: ExperimentDeps,
  request: { projectId: string; relPath: string; dir?: string | undefined },
): Promise<ResearchDeleteFigureResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const figurePath = resolve(dir, request.relPath)
  if (!figurePath.startsWith(dir + sep) || !isFigureFile(request.relPath)) {
    return rejected({ code: 'invalid-path', path: request.relPath })
  }
  try {
    await unlink(figurePath)
  } catch (error) {
    if (isNotFound(error)) return rejected({ code: 'figure-not-found', relPath: request.relPath })
    throw error
  }
  // Drop the metadata row with the file so a stale caption never outlives it.
  await deps.domain.table('figures').delete(`${request.projectId}:${request.relPath}`)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'figures.deleted',
    refs: {
      projectId: request.projectId,
      figureId: `${request.projectId}:${request.relPath}`,
    },
    payload: { relPath: request.relPath, destructive: true },
  })
  return success({ relPath: request.relPath })
}

/**
 * Convert one SVG figure of the addressed project's paper directory into a
 * LaTeX-embeddable product next to the source (`figures/foo.svg` →
 * `figures/foo.pdf`; the macOS Quick Look fallback writes `foo.png`). The
 * figures view's "insert into paper" flow calls this before referencing an
 * SVG. A fresh existing product (mtime at or after the SVG's) is reused
 * instead of re-converted. Path confinement matches `deleteFigure`; a
 * non-SVG path is `invalid-path`, a missing source `figure-not-found`, and
 * a machine with no usable converter a descriptive `operation-failed`.
 * @param deps - open wiki domain plus workspace root and SVG knobs.
 * @param request - the selected project, the paper-directory-relative SVG
 * path, and an optional explicit paper directory (relative to the
 * workspace) overriding the record's `paperDir`.
 * @returns the product's relative path and the converter used, or a
 * business failure.
 */
export async function convertFigure(
  deps: ExperimentDeps,
  request: { projectId: string; relPath: string; dir?: string | undefined },
): Promise<ResearchConvertFigureResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const figurePath = resolve(dir, request.relPath)
  if (!figurePath.startsWith(dir + sep) || !isFigureFile(request.relPath) || !request.relPath.toLowerCase().endsWith('.svg')) {
    return rejected({ code: 'invalid-path', path: request.relPath })
  }
  let sourceStats
  try {
    sourceStats = await stat(figurePath)
  } catch (error) {
    if (isNotFound(error)) return rejected({ code: 'figure-not-found', relPath: request.relPath })
    throw error
  }
  // Reuse a fresh product instead of re-converting: PDF first (the vector
  // pipeline's output), then the raster fallback's PNG.
  for (const ext of ['pdf', 'png'] as const) {
    const productRel = request.relPath.replace(/\.svg$/i, `.${ext}`)
    try {
      const productStats = await stat(resolve(dir, productRel))
      if (productStats.mtimeMs >= sourceStats.mtimeMs) {
        return success({ relPath: productRel, converter: 'cached' })
      }
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }
  const outcome = await convertSvgFigure(figurePath, deps.svg ?? {})
  if (!outcome.ok) {
    const message = outcome.code === 'no-converter'
      ? `No SVG converter found on this machine (looked for ${svgConverterNames().join(', ')}). Install one of them, or export the figure as PNG or PDF yourself.`
      : `${outcome.converter} failed to convert the SVG: ${outcome.message}`
    return rejected({ code: 'operation-failed', message })
  }
  const relPath = relative(dir, outcome.productPath).split(sep).join('/')
  return success({ relPath, converter: outcome.converter })
}

/**
 * Save one client-generated SVG figure (the experiments view's "generate
 * paper figure" button renders the metric comparison as a standalone SVG
 * document) into the addressed project's paper `figures/` directory, record
 * its caption in the wiki's figures table, register the file in the
 * project's artifact list, and convert it through the same pipeline
 * `convertFigure` runs so the LaTeX block can reference an embeddable
 * product. Only `.svg` names are accepted (the payload is text); the name
 * must be a plain file name and the content non-empty — violations are
 * `invalid-name` / `invalid-content`. A machine with no usable converter
 * still saves and registers, reporting the reason in `warning`.
 * @param deps - open wiki domain plus workspace root and SVG knobs.
 * @param request - the selected project, the destination file name, the SVG
 * document text, the caption to register, and an optional explicit paper
 * directory (relative to the workspace) overriding the record's `paperDir`.
 * @returns the saved path and caption plus the converted product when one
 * was produced, or a business failure.
 */
export async function saveFigure(
  deps: ExperimentDeps,
  request: {
    projectId: string
    name: string
    content: string
    caption?: string | undefined
    dir?: string | undefined
  },
): Promise<ResearchSaveFigureResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const name = request.name
  if (name === '' || name !== basename(name) || !name.toLowerCase().endsWith('.svg')) {
    return rejected({ code: 'invalid-name', name })
  }
  if (request.content.trim() === '') return rejected({ code: 'invalid-content' })
  const figuresDir = join(dir, 'figures')
  await mkdir(figuresDir, { recursive: true })
  const destination = join(figuresDir, name)
  await writeFileAtomic(destination, request.content, { mode: 0o666 })
  const relPath = `figures/${name}`
  // An SVG cannot be embedded by LaTeX directly; convert it next to the
  // save (the figure_save tool's rule) so the caller's insert can reference
  // the product. Without a converter the save still succeeds and the
  // warning says why.
  let converted: { relPath: string; converter: string } | undefined
  let warning: string | undefined
  const outcome = await convertSvgFigure(destination, deps.svg ?? {})
  if (outcome.ok) {
    converted = { relPath: `figures/${basename(outcome.productPath)}`, converter: outcome.converter }
  } else {
    warning = outcome.code === 'no-converter'
      ? `No SVG converter found (looked for ${svgConverterNames().join(', ')}); convert the figure before referencing it in LaTeX.`
      : `SVG conversion failed (${outcome.converter}: ${outcome.message})`
  }
  const id = `${request.projectId}:${relPath}`
  const existing = deps.domain.table('figures').get(id)
  const caption = request.caption?.trim() ?? existing?.caption ?? ''
  await deps.domain.table('figures').put(id, {
    id,
    projectId: request.projectId,
    relPath,
    caption,
    ...(existing?.experimentId === undefined ? {} : { experimentId: existing.experimentId }),
    sourcePath: destination,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  })
  // The artifact list is what the overview shows as the project's output.
  const artifactPath = `${record.paperDir ?? 'paper'}/${relPath}`
  await deps.domain.table('projects').update(record.id, current => ({
    ...current,
    artifacts: [...new Set([...current.artifacts, artifactPath])],
    updatedAt: new Date().toISOString(),
  }))
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'figures.saved',
    refs: {
      projectId: request.projectId,
      figureId: id,
      ...(existing?.experimentId === undefined ? {} : { experimentId: existing.experimentId }),
    },
    payload: { relPath, converted: converted === undefined ? null : converted.relPath },
  })
  return success({ relPath, caption, ...(converted === undefined ? {} : { converted }), ...(warning === undefined ? {} : { warning }) })
}


/**
 * Collect the `.tex` files that may reference a figure: the paper directory's
 * top level plus one level of subdirectories (the `sections/` convention).
 * Unreadable subdirectories are skipped; a missing paper directory yields an
 * empty list.
 * @param dir - absolute paper directory.
 * @returns absolute `.tex` file paths, name-sorted per directory.
 */
async function texFilesOf(dir: string): Promise<string[]> {
  const texIn = async (current: string): Promise<string[]> => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.tex'))
      .map(entry => join(current, entry.name))
      .sort()
  }
  const top = await texIn(dir)
  let subs: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return top
    throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory()) subs = [...subs, ...await texIn(join(dir, entry.name))]
  }
  return [...top, ...subs]
}

/**
 * Rewrite one figure's references in every `.tex` file of the paper
 * directory: exact `figures/foo.png` occurrences plus the extensionless
 * `\includegraphics{figures/foo}` form. Each file's read-rewrite-write runs
 * inside the file's cross-process writer lock — the same lock a panel
 * `savePaperSource`/`saveBibliography` commit holds — with the content re-read
 * under the lock, so a rename never overwrites a concurrent save's text it
 * never saw (the draft survives) and the rewrite always lands on the live
 * body. Only changed files are rewritten (atomically).
 * @param dir - absolute paper directory.
 * @param oldRelPath - the figure's previous paper-directory-relative path.
 * @param newRelPath - the figure's new paper-directory-relative path.
 * @returns the number of files rewritten.
 */
async function rewriteFigureReferences(dir: string, oldRelPath: string, newRelPath: string): Promise<number> {
  const oldStem = oldRelPath.replace(/\.[^.]+$/, '')
  const newStem = newRelPath.replace(/\.[^.]+$/, '')
  let rewritten = 0
  for (const file of await texFilesOf(dir)) {
    // The callback already holds the file's writer lock; nest the unlocked
    // read so the rewrite cannot self-deadlock (the locking reader is not
    // re-entrant), as `appendBibEntries` does for `references.bib`.
    const changed = await withFileLock(file, async (): Promise<boolean> => {
      const snapshot = await readPaperSourceUnlocked(file)
      if (snapshot === undefined) return false
      let next = snapshot.content.split(oldRelPath).join(newRelPath)
      if (oldStem !== oldRelPath) next = next.split(`{${oldStem}}`).join(`{${newStem}}`)
      if (next === snapshot.content) return false
      await writeFileAtomic(file, next, { mode: 0o666 })
      return true
    })
    if (changed) rewritten += 1
  }
  return rewritten
}

/**
 * Rename one figure file inside the addressed project's paper directory: the
 * file keeps its directory and extension (a same-extension `newName`, reduced
 * to its basename — anything else is `invalid-name`), the wiki's figures
 * metadata row follows the file (caption and experiment link preserved), the
 * project's artifact list is repointed, and every `.tex` reference to the old
 * path is rewritten (its count rides the result so the panel can report it).
 * Renaming onto an existing file is `invalid-input`; a missing source is
 * `figure-not-found`; a same-name rename is a successful no-op.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the current paper-directory-relative
 * path, the new bare file name, and an optional explicit paper directory.
 * @returns the new path plus the reference rewrite count, or a failure.
 */
export async function renameFigure(
  deps: ExperimentDeps,
  request: { projectId: string; relPath: string; newName: string; dir?: string | undefined },
): Promise<ResearchRenameFigureResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const oldPath = resolve(dir, request.relPath)
  if (!oldPath.startsWith(dir + sep) || !isFigureFile(request.relPath)) {
    return rejected({ code: 'invalid-path', path: request.relPath })
  }
  const newName = request.newName.trim()
  if (newName === '' || newName !== basename(newName) || !isFigureFile(newName)) {
    return rejected({ code: 'invalid-name', name: request.newName })
  }
  if (extname(newName).toLowerCase() !== extname(request.relPath).toLowerCase()) {
    return rejected({ code: 'invalid-input', message: 'newName must keep the original extension' })
  }
  const parent = dirname(request.relPath)
  const newRelPath = parent === '.' ? newName : `${parent}/${newName}`
  if (newRelPath === request.relPath) return success({ relPath: newRelPath, references: 0 })
  const newPath = resolve(dir, newRelPath)
  const oldStats = await stat(oldPath).catch((error: unknown) => {
    if (isNotFound(error)) return undefined
    throw error
  })
  if (oldStats === undefined) return rejected({ code: 'figure-not-found', relPath: request.relPath })
  const targetStats = await stat(newPath).catch((error: unknown) => {
    if (isNotFound(error)) return undefined
    throw error
  })
  if (targetStats !== undefined) {
    return rejected({ code: 'invalid-input', message: `a figure named '${newName}' already exists` })
  }
  await rename(oldPath, newPath)
  // The metadata row follows the file so its caption and links survive.
  const table = deps.domain.table('figures')
  const oldId = `${request.projectId}:${request.relPath}`
  const saved = table.get(oldId)
  if (saved !== undefined) {
    await table.put(`${request.projectId}:${newRelPath}`, { ...saved, id: `${request.projectId}:${newRelPath}`, relPath: newRelPath })
    await table.delete(oldId)
  }
  const references = await rewriteFigureReferences(dir, request.relPath, newRelPath)
  // The artifact list is what the overview shows as the project's output.
  const oldArtifact = `${record.paperDir ?? 'paper'}/${request.relPath}`
  if (record.artifacts.includes(oldArtifact)) {
    const newArtifact = `${record.paperDir ?? 'paper'}/${newRelPath}`
    await deps.domain.table('projects').update(record.id, current => ({
      ...current,
      artifacts: current.artifacts.map(path => (path === oldArtifact ? newArtifact : path)),
      updatedAt: new Date().toISOString(),
    }))
  }
  return success({ relPath: newRelPath, references })
}

/**
 * Upsert one figure's wiki metadata caption (the workbench's inline caption
 * edit and the agent's `figure_organize` tool). The row is keyed
 * `<projectId>:<relPath>`; a first write creates it, a later one replaces the
 * caption and preserves the experiment link and the first-write timestamp.
 * The path must look like a figure path (a servable extension, no traversal)
 * — anything else is `invalid-path`.
 * @param deps - open wiki domain.
 * @param request - the selected project, the paper-directory-relative figure
 * path, and the replacement caption.
 * @returns the path and the stored caption, or a business failure.
 */
export async function updateFigure(
  deps: ExperimentDeps,
  request: { projectId: string; relPath: string; caption: string },
): Promise<ResearchUpdateFigureResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  if (request.relPath.includes('..') || request.relPath.startsWith('/') || !isFigureFile(request.relPath)) {
    return rejected({ code: 'invalid-path', path: request.relPath })
  }
  const id = `${request.projectId}:${request.relPath}`
  const table = deps.domain.table('figures')
  const existing = table.get(id)
  const caption = request.caption.trim()
  await table.put(id, {
    id,
    projectId: request.projectId,
    relPath: request.relPath,
    caption,
    ...(existing?.experimentId === undefined ? {} : { experimentId: existing.experimentId }),
    ...(existing?.sourcePath === undefined ? {} : { sourcePath: existing.sourcePath }),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  })
  return success({ relPath: request.relPath, caption })
}
