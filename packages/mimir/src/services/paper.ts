/**
 * Paper domain module: outline/source/bibliography reads and writes under
 * optimistic concurrency, plus the LaTeX compile flow with its per-project
 * status map (carried by an explicit `ServiceState`). Thin forwarding of the
 * `paper.*` Remote namespace lives in `service.ts`.
 * @module dsh-mimir/src/services/paper
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parseTexOutline, reorderSections, reorderSubsections } from '../outline.ts'
import {
  isNotFound,
  readPaperSource,
  resolvePaperDir,
  savePaperSourceFile,
  saveTextFileOptimistic,
} from '../paper-source.ts'
import { entryFromPaper, parseBibtex, serializeBibtex } from '../bibtex.ts'
import { compileLatex } from '../tools/latex.ts'
import type { LatexToolOptions } from '../tools/latex.ts'
import { captureCompileSnapshot } from './paper-snapshots.ts'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type {
  BibEntry,
  ResearchBibliographyResult,
  ResearchCompileResult,
  ResearchCompileStatusResult,
  ResearchCompileStatusView,
  ResearchImportBibResult,
  ResearchOutlineResult,
  ResearchPaperSourceResult,
  ResearchSaveBibliographyResult,
  ResearchSavePaperSourceResult,
  SectionMove,
  SectionOutlineTitles,
  SubsectionMove,
} from '../types.ts'
import { rejected, success } from './common.ts'
import type { ServiceState } from './common.ts'

/** Everything the Paper domain functions need from the service scope. */
export interface PaperDeps {
  readonly workspaceDir: string
  readonly domain: ResearchWikiDomain
  readonly latex: LatexToolOptions
}

/** Status-map key for a compile addressed to no specific project. */
const DEFAULT_KEY = ''

/** The pre-first-compile view every project starts from. */
const IDLE_STATUS: ResearchCompileStatusView = Object.freeze({
  state: 'idle',
  issues: Object.freeze([]),
  engine: null,
  pdfUpdatedAt: null,
})

/** mtime (ms) of the compiled PDF, or null when no successful run produced one. */
async function pdfMtime(pdfPath: string): Promise<number | null> {
  try {
    return (await stat(pdfPath)).mtimeMs
  } catch (error) {
    // Only absence is expected here (no successful compile yet); anything else
    // still degrades to "no preview" rather than failing the compile reply.
    if (!isNotFound(error)) throw error
    return null
  }
}

/**
 * Parse the section outline of the addressed project's paper `main.tex`.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, plus an optional explicit paper
 * directory (relative to the workspace) overriding the record's `paperDir`.
 * @returns the heading tree, `project-not-found` for an unknown id,
 * `invalid-dir` for a directory escaping the workspace, or `paper-not-found`
 * before `/paper-write` has scaffolded the skeleton.
 */
export async function getPaperOutline(
  deps: PaperDeps,
  request: { projectId: string; dir?: string | undefined },
): Promise<ResearchOutlineResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  let tex: string
  try {
    tex = await readFile(join(dir, 'main.tex'), 'utf8')
  } catch (error) {
    if (isNotFound(error)) return rejected({ code: 'paper-not-found' })
    throw error
  }
  return success({ projectId: request.projectId, nodes: Object.freeze(parseTexOutline(tex)) })
}

/**
 * Read the addressed project's paper `main.tex` with the mtime its content
 * belongs to. The mtime is the optimistic-concurrency base for
 * `savePaperSource`.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, plus an optional explicit paper
 * directory (relative to the workspace) overriding the record's `paperDir`.
 * @returns content and mtime, `project-not-found` for an unknown id,
 * `invalid-dir` for a directory escaping the workspace, or `paper-not-found`
 * before `/paper-write` has scaffolded the skeleton.
 */
export async function getPaperSource(
  deps: PaperDeps,
  request: { projectId: string; dir?: string | undefined },
): Promise<ResearchPaperSourceResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const snapshot = await readPaperSource(join(dir, 'main.tex'))
  if (snapshot === undefined) return rejected({ code: 'paper-not-found' })
  return success(snapshot)
}

/**
 * Replace the addressed project's paper `main.tex` under optimistic
 * concurrency: the commit only lands when the file's mtime still equals
 * `baseMtimeMs`. The mtime check and the atomic write run inside the writer
 * lock, so an agent writing through the file tools can never interleave a
 * check-then-write.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the complete next content, the
 * mtime the caller's draft is based on, and an optional explicit paper
 * directory (relative to the workspace) overriding the record's `paperDir`.
 * @returns the committed mtime, `project-not-found`, `paper-not-found`,
 * `invalid-dir`, or `conflict` carrying the mtime that displaced the base.
 */
export async function savePaperSource(
  deps: PaperDeps,
  request: {
    projectId: string
    content: string
    baseMtimeMs: number
    dir?: string | undefined
  },
): Promise<ResearchSavePaperSourceResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const outcome = await savePaperSourceFile(join(dir, 'main.tex'), request.content, request.baseMtimeMs)
  if (outcome.kind === 'missing') return rejected({ code: 'paper-not-found' })
  if (outcome.kind === 'conflict') {
    return rejected({ code: 'conflict', currentMtimeMs: outcome.currentMtimeMs })
  }
  return success({ mtimeMs: outcome.mtimeMs })
}

/**
 * Reorder the top-level `\section` blocks of the addressed project's paper
 * `main.tex`. `baseOutline` is the top-level section title sequence the
 * client's drag gesture was based on; when the file's current sequence
 * differs (the agent edited the document mid-gesture) the call rejects with
 * `conflict` and writes nothing. The reorder and the commit ride the same
 * optimistic-concurrency path as `savePaperSource` (the snapshot's mtime is
 * the save base), and everything outside the moved blocks survives
 * byte-for-byte.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the ordered moves, the outline the
 * client saw, and an optional explicit paper directory (relative to the
 * workspace) overriding the record's `paperDir`.
 * @returns the committed mtime, `project-not-found`, `paper-not-found`,
 * `invalid-dir`, `section-not-found` for an unknown move title,
 * `invalid-input` for an out-of-range target, or `conflict`.
 */
export async function reorderPaperSections(
  deps: PaperDeps,
  request: {
    projectId: string
    moves: SectionMove[]
    baseOutline: string[]
    dir?: string | undefined
  },
): Promise<ResearchSavePaperSourceResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const texPath = join(dir, 'main.tex')
  const snapshot = await readPaperSource(texPath)
  if (snapshot === undefined) return rejected({ code: 'paper-not-found' })
  const sections = parseTexOutline(snapshot.content)
    .filter(node => node.level === 1)
    .map(node => node.title)
  if (sections.length !== request.baseOutline.length
    || sections.some((title, index) => title !== request.baseOutline[index])) {
    return rejected({ code: 'conflict', currentMtimeMs: snapshot.mtimeMs })
  }
  if (request.moves.length === 0) return success({ mtimeMs: snapshot.mtimeMs })
  const reordered = reorderSections(snapshot.content, request.moves)
  if (reordered.kind === 'section-not-found') {
    return rejected({ code: 'section-not-found', title: reordered.title })
  }
  if (reordered.kind === 'invalid-move') {
    return rejected({ code: 'invalid-input', message: `section target index ${reordered.targetIndex} out of range` })
  }
  const outcome = await saveTextFileOptimistic(texPath, reordered.tex, snapshot.mtimeMs)
  if (outcome.kind === 'missing') return rejected({ code: 'paper-not-found' })
  if (outcome.kind === 'conflict') {
    return rejected({ code: 'conflict', currentMtimeMs: outcome.currentMtimeMs })
  }
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'writing.paper.reordered',
    refs: { projectId: request.projectId },
    payload: { level: 'section', moves: request.moves.length },
  })
  return success({ mtimeMs: outcome.mtimeMs })
}

/**
 * Reorder the `\subsection` blocks of the addressed project's paper
 * `main.tex`, inside their own section or across sections. `baseOutline` is
 * the section/subsection title tree the client's drag gesture was based on;
 * when the file's current tree differs (the agent edited the document
 * mid-gesture) the call rejects with `conflict` and writes nothing. The
 * commit rides the same optimistic-concurrency path as `savePaperSource`,
 * and everything outside the moved blocks survives byte-for-byte.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the ordered moves, the outline the
 * client saw, and an optional explicit paper directory (relative to the
 * workspace) overriding the record's `paperDir`.
 * @returns the committed mtime, `project-not-found`, `paper-not-found`,
 * `invalid-dir`, `section-not-found` for an unknown section title,
 * `subsection-not-found` for an unknown subsection title, `invalid-input`
 * for an out-of-range target, or `conflict`.
 */
export async function reorderPaperSubsections(
  deps: PaperDeps,
  request: {
    projectId: string
    moves: SubsectionMove[]
    baseOutline: SectionOutlineTitles[]
    dir?: string | undefined
  },
): Promise<ResearchSavePaperSourceResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const texPath = join(dir, 'main.tex')
  const snapshot = await readPaperSource(texPath)
  if (snapshot === undefined) return rejected({ code: 'paper-not-found' })
  const outline: SectionOutlineTitles[] = parseTexOutline(snapshot.content)
    .filter(node => node.level === 1)
    .map(node => ({ title: node.title, subsections: node.children.map(child => child.title) }))
  if (outline.length !== request.baseOutline.length
    || outline.some((section, index) => {
      const base = request.baseOutline[index]
      return base === undefined || section.title !== base.title
        || section.subsections.length !== base.subsections.length
        || section.subsections.some((title, subIndex) => title !== base.subsections[subIndex])
    })) {
    return rejected({ code: 'conflict', currentMtimeMs: snapshot.mtimeMs })
  }
  if (request.moves.length === 0) return success({ mtimeMs: snapshot.mtimeMs })
  const reordered = reorderSubsections(snapshot.content, request.moves)
  if (reordered.kind === 'section-not-found') {
    return rejected({ code: 'section-not-found', title: reordered.title })
  }
  if (reordered.kind === 'subsection-not-found') {
    return rejected({ code: 'subsection-not-found', sectionTitle: reordered.sectionTitle, title: reordered.title })
  }
  if (reordered.kind === 'invalid-move') {
    return rejected({ code: 'invalid-input', message: `subsection target index ${reordered.targetIndex} out of range` })
  }
  const outcome = await saveTextFileOptimistic(texPath, reordered.tex, snapshot.mtimeMs)
  if (outcome.kind === 'missing') return rejected({ code: 'paper-not-found' })
  if (outcome.kind === 'conflict') {
    return rejected({ code: 'conflict', currentMtimeMs: outcome.currentMtimeMs })
  }
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'writing.paper.reordered',
    refs: { projectId: request.projectId },
    payload: { level: 'subsection', moves: request.moves.length },
  })
  return success({ mtimeMs: outcome.mtimeMs })
}

/**
 * Read the addressed project's `references.bib` as parsed entries. An
 * absent file is a SUCCESS with an empty list and a null mtime — the panel
 * treats "no bibliography yet" as a normal state, not an error.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, plus an optional explicit paper
 * directory (relative to the workspace) overriding the record's `paperDir`.
 * @returns entries in file order plus the mtime the parse belongs to (the
 * optimistic-concurrency base for `saveBibliography`; null when absent), or
 * `project-not-found`/`invalid-dir` for a bad address.
 */
export async function getBibliography(
  deps: PaperDeps,
  request: { projectId: string; dir?: string | undefined },
): Promise<ResearchBibliographyResult> {
  const record = deps.domain.table('projects').get(request.projectId)
  if (record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record.paperDir ?? '' })
  const snapshot = await readPaperSource(join(dir, 'references.bib'))
  if (snapshot === undefined) return success({ entries: Object.freeze([]), mtimeMs: null })
  return success({ entries: Object.freeze(parseBibtex(snapshot.content)), mtimeMs: snapshot.mtimeMs })
}

/**
 * Replace the addressed project's `references.bib` under optimistic
 * concurrency, creating it when it does not exist yet: a null
 * `baseMtimeMs` states "I read an absent file" and only a create commits;
 * otherwise the file's mtime must still equal the base. The paper directory
 * itself must exist (`paper-not-found` otherwise) — a bibliography without
 * a scaffolded paper is never created.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the complete next entry list, the
 * mtime the caller's draft is based on (null for create-only), and an
 * optional explicit paper directory.
 * @returns the committed mtime, `project-not-found`, `paper-not-found`,
 * `invalid-dir`, `bib-not-found` when the file was expected but is gone, or
 * `conflict` carrying the mtime that displaced the base.
 */
export async function saveBibliography(
  deps: PaperDeps,
  request: {
    projectId: string
    entries: BibEntry[]
    baseMtimeMs: number | null
    dir?: string | undefined
  },
): Promise<ResearchSaveBibliographyResult> {
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
  const outcome = await saveTextFileOptimistic(
    join(dir, 'references.bib'), serializeBibtex(request.entries), request.baseMtimeMs,
  )
  if (outcome.kind === 'missing') return rejected({ code: 'bib-not-found' })
  if (outcome.kind === 'conflict') {
    return rejected({ code: 'conflict', currentMtimeMs: outcome.currentMtimeMs })
  }
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'writing.bib.saved',
    refs: { projectId: request.projectId },
    payload: { entries: request.entries.length, created: request.baseMtimeMs === null },
  })
  return success({ mtimeMs: outcome.mtimeMs })
}

/**
 * Append parsed BibTeX entries to the addressed project's `references.bib`,
 * skipping citation keys already present. The paper directory itself must
 * exist (`paper-not-found` otherwise). The read-merge-write runs inside the
 * writer lock, so a concurrent panel save or agent write cannot be lost.
 * Shared by `importPapersToBib` (entries projected from wiki papers) and the
 * Zotero collection export (entries parsed from the API's BibTeX).
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the entries to append, and an
 * optional explicit paper directory.
 * @returns the appended and the already-present citation keys, or
 * `project-not-found`/`paper-not-found`/`invalid-dir`.
 */
export async function appendBibEntries(
  deps: PaperDeps,
  request: {
    projectId: string
    entries: readonly BibEntry[]
    dir?: string | undefined
  },
): Promise<ResearchImportBibResult> {
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
  const bibPath = join(dir, 'references.bib')
  return await withFileLock(bibPath, async (): Promise<ResearchImportBibResult> => {
    const snapshot = await readPaperSource(bibPath)
    const entries = parseBibtex(snapshot?.content ?? '')
    const present = new Set(entries.map(entry => entry.key))
    const added: string[] = []
    const skipped: string[] = []
    for (const incoming of request.entries) {
      if (present.has(incoming.key)) { skipped.push(incoming.key); continue }
      entries.push(incoming)
      present.add(incoming.key)
      added.push(incoming.key)
    }
    if (added.length > 0) {
      await writeFileAtomic(bibPath, serializeBibtex(entries), { mode: 0o666 })
    }
    return success({ added: Object.freeze(added), skipped: Object.freeze(skipped) })
  })
}

/**
 * Append `@misc` entries for the given remembered papers to the addressed
 * project's `references.bib`, skipping citation keys already present. Every
 * arXiv id must name a wiki paper (`paper-not-found` on the first unknown
 * one — nothing is written then). The merge itself rides
 * {@link appendBibEntries}.
 * @param deps - workspace root and open wiki domain.
 * @param request - the selected project, the arXiv ids to append, and an
 * optional explicit paper directory.
 * @returns the appended and the already-present citation keys, or
 * `project-not-found`/`paper-not-found`/`invalid-dir`.
 */
export async function importPapersToBib(
  deps: PaperDeps,
  request: {
    projectId: string
    arxivIds: string[]
    dir?: string | undefined
  },
): Promise<ResearchImportBibResult> {
  const papers = deps.domain.table('papers')
  const entries: BibEntry[] = []
  for (const arxivId of request.arxivIds) {
    const paper = papers.get(arxivId)
    if (paper === undefined) return rejected({ code: 'paper-not-found' })
    entries.push(entryFromPaper(paper))
  }
  const result = await appendBibEntries(deps, {
    projectId: request.projectId,
    entries,
    ...(request.dir === undefined ? {} : { dir: request.dir }),
  })
  if (result.ok) {
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'writing.bib.imported',
      refs: { projectId: request.projectId },
      payload: { added: result.value.added.length, skipped: result.value.skipped.length },
    })
  }
  return result
}

/**
 * Compile the addressed project's paper directory once and record the
 * outcome. A successful run also captures the paper's `.tex`/`.bib` sources
 * as a new snapshot under `<workspaceDir>/snapshots/<projectId>/` (kept to
 * the newest 50); the capture is best-effort and never fails the compile.
 * @param deps - workspace root, open wiki domain, and LaTeX knobs.
 * @param state - the service's mutable compile-status map (read/write here).
 * @param request - the addressed project (omitted compiles the unkeyed
 * slot), plus an optional explicit paper directory (relative to the
 * workspace) overriding the record's `paperDir`.
 * @param signal - caller cancellation; kills the engine process.
 * @returns the settled status (`ok` carries no business failure: a TeX-level
 * failure is `state: 'error'` with the parsed issues), or a business failure
 * for an unknown project, an escaping directory, a concurrent run, or an
 * engine that cannot start.
 */
export async function compile(
  deps: PaperDeps,
  state: ServiceState,
  request: { projectId?: string; dir?: string | undefined },
  signal: AbortSignal,
): Promise<ResearchCompileResult> {
  const key = request.projectId ?? DEFAULT_KEY
  const record = request.projectId === undefined
    ? undefined
    : deps.domain.table('projects').get(request.projectId)
  if (request.projectId !== undefined && record === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  const dir = resolvePaperDir(deps.workspaceDir, request.dir, record?.paperDir)
  if (dir === undefined) return rejected({ code: 'invalid-dir', dir: request.dir ?? record?.paperDir ?? '' })
  const previous = state.compileStatus.get(key) ?? IDLE_STATUS
  if (previous.state === 'running') {
    return rejected({ code: 'operation-failed', message: 'a compile is already running for this project' })
  }
  state.compileStatus.set(key, { ...previous, state: 'running' })

  let outcome
  try {
    outcome = await compileLatex(dir, deps.latex, signal)
  } catch (error) {
    // Missing engine (ENOENT) or missing paper directory: the run never
    // produced a log, so there are no issues to show — only the message.
    const settled: ResearchCompileStatusView = { ...previous, state: 'error' }
    state.compileStatus.set(key, settled)
    return rejected({
      code: 'operation-failed',
      message: redactDirs(
        error instanceof Error ? error.message : 'latex compile failed to run',
        deps.workspaceDir,
        dir,
      ),
    })
  }

  const settled: ResearchCompileStatusView = Object.freeze({
    state: outcome.success ? 'ok' : 'error',
    issues: Object.freeze([...outcome.errors, ...outcome.warnings]),
    engine: outcome.engine,
    pdfUpdatedAt: outcome.success
      ? await pdfMtime(join(dir, 'main.pdf'))
      : previous.pdfUpdatedAt,
  })
  state.compileStatus.set(key, settled)
  await emitEvent(deps.domain, {
    actor: PANEL_ACTOR,
    action: 'writing.compile.settled',
    refs: {
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    },
    payload: { state: settled.state, engine: settled.engine, issues: settled.issues.length },
  })
  if (outcome.success && request.projectId !== undefined) {
    // Best-effort: a snapshot I/O failure must never fail the compile it
    // rides on. The unkeyed compile slot never snapshots (snapshots are
    // per project).
    await captureCompileSnapshot(deps, request.projectId, dir).catch(() => undefined)
  }
  return success(settled)
}

/**
 * Read the last known compile status without running anything.
 * @param deps - workspace root and open wiki domain.
 * @param state - the service's mutable compile-status map (read only here).
 * @param request - the addressed project; omitted reads the unkeyed slot.
 * @returns the recorded status, `idle` before the first compile.
 */
export function getCompileStatus(
  deps: PaperDeps,
  state: ServiceState,
  request: { projectId?: string },
): Promise<ResearchCompileStatusResult> {
  const key = request.projectId ?? DEFAULT_KEY
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return Promise.resolve(rejected({ code: 'project-not-found', projectId: request.projectId }))
  }
  return Promise.resolve(success(state.compileStatus.get(key) ?? IDLE_STATUS))
}

/**
 * Redact absolute directory prefixes from an error message before it reaches
 * the wire (no absolute paths in error text). Each directory is masked in its
 * native and forward-slash spellings, so engine/IO failures stay actionable
 * without leaking the local workspace layout.
 */
function redactDirs(message: string, workspaceDir: string | undefined, paperDir: string | undefined): string {
  let redacted = message
  if (workspaceDir !== undefined) {
    redacted = redacted
      .replaceAll(workspaceDir, '<workspace>')
      .replaceAll(workspaceDir.replaceAll('\\', '/'), '<workspace>')
  }
  if (paperDir !== undefined) {
    redacted = redacted
      .replaceAll(paperDir, '<paper-dir>')
      .replaceAll(paperDir.replaceAll('\\', '/'), '<paper-dir>')
  }
  return redacted
}
