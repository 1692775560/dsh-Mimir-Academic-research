/**
 * Library domain module: the literature workbench (papers table CRUD, arXiv
 * search/import, and the workspace PDF fetch). Thin forwarding of the
 * `library.*` Remote namespace lives in `service.ts`.
 * @module dsh-mimir/src/services/library
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchArxivPdf, fetchArxivSearch, isValidArxivId, paperPdfFileName } from '../tools/arxiv.ts'
import { fetchWebSearch } from '../tools/web-search.ts'
import type { WebSearchRunner } from '../tools/web-search.ts'
import { detectPackageManager, installCommandFor } from '../pm-detect.ts'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type {
  ArxivEntry,
  PaperRecord,
  ResearchFetchPaperPdfResult,
  ResearchImportPaperResult,
  ResearchPapersResult,
  ResearchRemovePaperResult,
  ResearchSearchArxivResult,
  ResearchSearchWebResult,
  ResearchUpdatePaperResult,
} from '../types.ts'
import { rejected, success } from './common.ts'

/** Everything the Library domain functions need from the service scope. */
export interface LibraryDeps {
  readonly workspaceDir: string
  readonly domain: ResearchWikiDomain
  /** Resolved web-search knobs; absent disables `searchWeb` (reports unavailable). */
  readonly search?: {
    readonly command: string
    readonly timeoutMs: number
    /** Test hook replacing the real child process. */
    readonly run?: WebSearchRunner
  }
  /** Resolved arXiv fetch knobs; absent falls back to the module default timeout. */
  readonly arxiv?: {
    readonly timeoutMs: number
  }
}

/** Timeout of one arXiv API request made on the panel's behalf when the plugin config does not set one. */
const ARXIV_FETCH_TIMEOUT_MS = 30_000
/** Timeout of one panel-driven arXiv PDF download. */
const ARXIV_PDF_FETCH_TIMEOUT_MS = 60_000
/** Workspace-relative directory the fetched paper PDFs land in. */
const PAPER_PDF_DIR = 'papers'
/** Default result cap of one panel-driven arXiv search. */
const ARXIV_SEARCH_DEFAULT_MAX_RESULTS = 10
/** Hard result cap of one panel-driven arXiv search. */
const ARXIV_SEARCH_MAX_RESULTS = 50

/**
 * Serialize paper read-modify-write commits within this host process.
 * ponytail: process-wide per-id lock; split by domain only if contention is measurable.
 */
const paperMutationTails = new Map<string, Promise<void>>()

async function withPaperMutationLock<T>(arxivId: string, mutation: () => Promise<T>): Promise<T> {
  const previous = paperMutationTails.get(arxivId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  paperMutationTails.set(arxivId, current)
  await previous
  try {
    return await mutation()
  } finally {
    release()
    if (paperMutationTails.get(arxivId) === current) paperMutationTails.delete(arxivId)
  }
}

/** Atomically replace one binary file through a unique same-directory sibling. */
async function writeBytesAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, bytes, { mode: 0o666 })
    await rename(tempPath, filePath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

/**
 * The ONE re-import merge every paper-ingest entry point shares (R29 /
 * #230): the panel's `importPaper`, the Zotero item import (both paths),
 * and the agent's `wiki_note add_paper`. `fresh` is the full record the
 * entry point would write for a NEW paper — source metadata refreshed,
 * curated fields at their first-import defaults. A re-import then merges
 * instead of overwriting, so nothing the workbench curated can drift or
 * vanish:
 * - notes/tags/projectIds/relevance/pdfPath/addedAt come from the STORED
 *   record (a fetched-PDF pointer and the first-import timestamp survive
 *   every re-ingest; project links union with `linkProjectId`);
 * - title/authors/summary/url refresh from the source;
 * - published/doi refresh when the source carries them, else keep the
 *   stored value;
 * - `options.notes` is an explicit replacement (the agent's add_paper
 *   note) winning over the stored note.
 * @param fresh - the record for the new-paper case (addedAt = now).
 * @param existing - the stored record, or undefined on a first import.
 * @param options - the project link to union in and an explicit note.
 * @returns the record to persist.
 */
export function mergePaperRecord(
  fresh: PaperRecord,
  existing: PaperRecord | undefined,
  options: {
    readonly linkProjectId?: string | undefined
    readonly notes?: string | undefined
  } = {},
): PaperRecord {
  const projectIds = [...new Set([
    ...(existing?.projectIds ?? []),
    ...fresh.projectIds,
    ...(options.linkProjectId === undefined ? [] : [options.linkProjectId]),
  ])]
  if (existing === undefined) {
    return { ...fresh, projectIds }
  }
  return {
    ...fresh,
    notes: options.notes ?? (existing.notes !== '' ? existing.notes : fresh.notes),
    tags: [...existing.tags],
    projectIds,
    ...(existing.relevance === undefined ? {} : { relevance: existing.relevance }),
    ...(existing.pdfPath === undefined ? {} : { pdfPath: existing.pdfPath }),
    addedAt: existing.addedAt,
    ...(fresh.published === undefined
      ? (existing.published === undefined ? {} : { published: existing.published })
      : {}),
    ...(fresh.doi === undefined
      ? (existing.doi === undefined ? {} : { doi: existing.doi })
      : {}),
  }
}

/**
 * List every remembered paper, most recently added first.
 * @param deps - open wiki domain.
 * @returns the literature cards for the panel's papers view.
 */
export function listPapers(deps: LibraryDeps): Promise<ResearchPapersResult> {
  const papers = [...deps.domain.table('papers').entries()]
    .map(([, record]) => record)
    .sort((left, right) => right.addedAt.localeCompare(left.addedAt))
  return Promise.resolve(success({ papers: Object.freeze(papers) }))
}

/**
 * Search arXiv on the panel's behalf. The query must be non-empty
 * (`invalid-input` otherwise); the request carries the configured timeout
 * (default 30s; the Atom API attempt inside fails fast and falls back to the
 * web search page within the same budget) and transport/HTTP failures settle
 * as `operation-failed` with the underlying message.
 * @param deps - the resolved arXiv knobs (absent = the module default timeout).
 * @param request - the free-text query and an optional result cap
 * (default 10, hard cap 50).
 * @returns the parsed entries, newest API order preserved.
 */
export async function searchArxiv(
  deps: LibraryDeps,
  request: { query: string; maxResults?: number },
): Promise<ResearchSearchArxivResult> {
  const query = request.query.trim()
  if (query === '') return rejected({ code: 'invalid-input', message: 'query must be non-empty' })
  const maxResults = request.maxResults ?? ARXIV_SEARCH_DEFAULT_MAX_RESULTS
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > ARXIV_SEARCH_MAX_RESULTS) {
    return rejected({ code: 'invalid-input', message: `maxResults must be an integer between 1 and ${ARXIV_SEARCH_MAX_RESULTS}` })
  }
  try {
    const timeoutMs = deps.arxiv?.timeoutMs ?? ARXIV_FETCH_TIMEOUT_MS
    const results = await fetchArxivSearch(query, maxResults, AbortSignal.timeout(timeoutMs))
    return success({ results: Object.freeze(results) })
  } catch (error) {
    return rejected({
      code: 'operation-failed',
      message: error instanceof Error ? error.message : 'arXiv search failed',
    })
  }
}

/**
 * Search the web through the configured sxng CLI on the panel's behalf.
 * The query must be non-empty (`invalid-input` otherwise); the request
 * carries the configured timeout and CLI/transport failures settle as
 * `operation-failed` with the underlying message. When no search command
 * is configured the call reports unavailable through `operation-failed`
 * with setup guidance.
 * @param deps - the resolved web-search knobs (absent = unavailable).
 * @param request - the free-text query and an optional result cap
 * (default 10, hard cap 50), plus optional category/language modifiers.
 * @returns the parsed rows, engine order preserved.
 */
export async function searchWeb(
  deps: LibraryDeps,
  request: {
    query: string
    maxResults?: number
    categories?: string | undefined
    lang?: string | undefined
  },
): Promise<ResearchSearchWebResult> {
  const search = deps.search
  if (search === undefined) {
    const command = installCommandFor(detectPackageManager())
    return rejected({
      code: 'operation-failed',
      message: `Web search is not configured: install the sxng CLI with ${command}, then set the plugin's search.command to 'sxng' (or leave it 'auto') and run sxng init against a self-hosted SearXNG.`,
    })
  }
  const query = request.query.trim()
  if (query === '') return rejected({ code: 'invalid-input', message: 'query must be non-empty' })
  const maxResults = request.maxResults ?? ARXIV_SEARCH_DEFAULT_MAX_RESULTS
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > ARXIV_SEARCH_MAX_RESULTS) {
    return rejected({ code: 'invalid-input', message: `maxResults must be an integer between 1 and ${ARXIV_SEARCH_MAX_RESULTS}` })
  }
  try {
    const results = await fetchWebSearch(query, {
      command: search.command,
      timeoutMs: search.timeoutMs,
      maxResults,
      ...(request.categories === undefined ? {} : { categories: request.categories }),
      ...(request.lang === undefined ? {} : { lang: request.lang }),
      ...(search.run === undefined ? {} : { run: search.run }),
    })
    return success({ results: Object.freeze(results) })
  } catch (error) {
    return rejected({
      code: 'operation-failed',
      message: error instanceof Error ? error.message : 'web search failed',
    })
  }
}

/**
 * Remember one arXiv entry in the wiki's papers table. The write is an
 * idempotent upsert keyed by the bare arXiv id: a re-import refreshes the
 * metadata but rides the shared {@link mergePaperRecord}, so the curated
 * fields (notes, tags, project links, relevance, the fetched-PDF pointer)
 * and the first-write timestamp survive. A `projectId` links the paper to
 * that project (unknown id is `project-not-found`) — the workbench passes
 * the selected project so each project's literature view fills up on its
 * own.
 * @param deps - open wiki domain.
 * @param request - the parsed entry (an empty id or title is `invalid-input`)
 * plus the optional project link.
 * @returns whether the paper was newly imported (false on a refresh).
 */
export async function importPaper(
  deps: LibraryDeps,
  request: { entry: ArxivEntry; projectId?: string | undefined },
): Promise<ResearchImportPaperResult> {
  const entry = request.entry
  const arxivId = entry.id.trim()
  if (arxivId === '' || entry.title.trim() === '') {
    return rejected({ code: 'invalid-input', message: 'entry id and title must be non-empty' })
  }
  // The id joins filesystem paths (cached PDF, figure crops) downstream —
  // reject anything that could escape a directory join.
  if (!isValidArxivId(arxivId)) {
    return rejected({ code: 'invalid-input', message: `unsafe arXiv id: ${arxivId}` })
  }
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  return withPaperMutationLock(arxivId, async () => {
    const table = deps.domain.table('papers')
    const existing = table.get(arxivId)
    // The publication date is source metadata; a re-import without one keeps
    // the previously recorded value rather than dropping it (the merge).
    const published = entry.published !== '' ? entry.published : undefined
    const record = mergePaperRecord({
      arxivId,
      title: entry.title,
      authors: [...entry.authors],
      summary: entry.summary,
      url: entry.url === '' ? `https://arxiv.org/abs/${arxivId}` : entry.url,
      notes: '',
      tags: [],
      projectIds: [],
      addedAt: new Date().toISOString(),
      ...(published === undefined ? {} : { published }),
    }, existing, { linkProjectId: request.projectId })
    await table.put(arxivId, record)
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'literature.paper.imported',
      refs: { paperId: arxivId },
      payload: { title: entry.title, imported: existing === undefined },
    })
    return success({ imported: existing === undefined })
  })
}

/**
 * Remove one remembered paper; an unknown arXiv id is `paper-not-found`.
 * @param deps - open wiki domain.
 * @param request - the bare arXiv id.
 * @returns the removed id.
 */
export async function removePaper(
  deps: LibraryDeps,
  request: { arxivId: string },
): Promise<ResearchRemovePaperResult> {
  return withPaperMutationLock(request.arxivId, async () => {
    const table = deps.domain.table('papers')
    const removed = table.get(request.arxivId)
    if (removed === undefined) {
      return rejected({ code: 'paper-not-found' })
    }
    await table.delete(request.arxivId)
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'literature.paper.removed',
      refs: { paperId: request.arxivId },
      payload: { title: removed.title, destructive: true },
    })
    return success({ arxivId: request.arxivId })
  })
}

/**
 * Partially update one remembered paper's organization fields: only the
 * present fields (`tags`, `projectIds`, `notes`, `relevance`) change. Tags
 * are trimmed, emptied out, and deduped; every linked project id must exist
 * in the wiki (`invalid-input` otherwise). A `relevance` write scores the
 * paper against one project (the project must exist; the score is a finite
 * 0–10 number) and lands under that project's key, leaving other projects'
 * verdicts untouched. An unknown arXiv id is `paper-not-found`.
 * @param deps - open wiki domain.
 * @param request - the bare arXiv id plus the fields to replace.
 * @returns the stored record after the update.
 */
export async function updatePaper(
  deps: LibraryDeps,
  request: {
    arxivId: string
    tags?: string[] | undefined
    projectIds?: string[] | undefined
    notes?: string | undefined
    relevance?: { projectId: string; score: number; reason: string } | undefined
  },
): Promise<ResearchUpdatePaperResult> {
  const table = deps.domain.table('papers')
  const existing = table.get(request.arxivId)
  if (existing === undefined) return rejected({ code: 'paper-not-found' })
  if (request.projectIds !== undefined) {
    for (const projectId of request.projectIds) {
      if (deps.domain.table('projects').get(projectId) === undefined) {
        return rejected({ code: 'invalid-input', message: `unknown project: ${projectId}` })
      }
    }
  }
  if (request.relevance !== undefined) {
    const { projectId, score } = request.relevance
    if (deps.domain.table('projects').get(projectId) === undefined) {
      return rejected({ code: 'project-not-found', projectId })
    }
    if (!Number.isFinite(score) || score < 0 || score > 10) {
      return rejected({ code: 'invalid-input', message: 'relevance score must be a finite number between 0 and 10' })
    }
  }
  return withPaperMutationLock(request.arxivId, async () => {
    const current = table.get(request.arxivId)
    if (current === undefined) return rejected({ code: 'paper-not-found' })
    const next: PaperRecord = {
      ...current,
      tags: request.tags === undefined
        ? current.tags
        : [...new Set(request.tags.map(tag => tag.trim()).filter(tag => tag !== ''))],
      projectIds: request.projectIds ?? current.projectIds,
      notes: request.notes ?? current.notes,
      ...(request.relevance === undefined ? {} : {
        relevance: {
          ...current.relevance,
          [request.relevance.projectId]: {
            score: request.relevance.score,
            reason: request.relevance.reason,
            at: new Date().toISOString(),
          },
        },
      }),
    }
    await table.put(request.arxivId, next)
    const changed = (['tags', 'projectIds', 'notes', 'relevance'] as const).filter(field => request[field] !== undefined)
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'literature.paper.updated',
      refs: { paperId: request.arxivId },
      payload: { changed: [...changed] },
    })
    return success({ paper: next })
  })
}

/**
 * Download one remembered paper's arXiv PDF into the workspace and link it
 * on the record: the bytes land at `papers/<arxiv id>.pdf` under the
 * workspace root (same-name overwrite on a refetch, so a new arXiv version
 * replaces the stale copy) and the record's `pdfPath` points at it. The
 * panel reads the file back through the `/research/paper-pdf/<id>` route.
 * An unknown arXiv id is `paper-not-found`; transport/HTTP/oversize
 * failures settle as `operation-failed` with the underlying message.
 * @param deps - workspace root and open wiki domain.
 * @param request - the bare arXiv id.
 * @returns the stored record after the update.
 */
export async function fetchPaperPdf(
  deps: LibraryDeps,
  request: { arxivId: string },
): Promise<ResearchFetchPaperPdfResult> {
  const table = deps.domain.table('papers')
  // encodeURIComponent leaves dots untouched, so `..` would escape papers/ —
  // the id must pass the path-safety predicate before any join (or lookup).
  if (!isValidArxivId(request.arxivId)) {
    return rejected({ code: 'invalid-input', message: `unsafe arXiv id: ${request.arxivId}` })
  }
  const existing = table.get(request.arxivId)
  if (existing === undefined) return rejected({ code: 'paper-not-found' })
  let bytes: Uint8Array
  try {
    bytes = await fetchArxivPdf(request.arxivId, AbortSignal.timeout(ARXIV_PDF_FETCH_TIMEOUT_MS))
  } catch (error) {
    return rejected({
      code: 'operation-failed',
      message: error instanceof Error ? error.message : 'arXiv PDF download failed',
    })
  }
  const relPath = `${PAPER_PDF_DIR}/${paperPdfFileName(request.arxivId)}`
  const dir = join(deps.workspaceDir, PAPER_PDF_DIR)
  await mkdir(dir, { recursive: true })
  const pdfPath = join(dir, paperPdfFileName(request.arxivId))
  await writeBytesAtomic(pdfPath, bytes)
  // The download is asynchronous: refresh the record before committing so
  // concurrent notes/tags edits survive. A delete wins over a late download.
  return withPaperMutationLock(request.arxivId, async () => {
    const current = table.get(request.arxivId)
    if (current === undefined || current.addedAt !== existing.addedAt) {
      await unlink(pdfPath).catch(() => {})
      return rejected({ code: 'paper-not-found' })
    }
    const next: PaperRecord = { ...current, pdfPath: relPath }
    await table.put(request.arxivId, next)
    await emitEvent(deps.domain, {
      actor: PANEL_ACTOR,
      action: 'literature.pdf.fetched',
      refs: { paperId: request.arxivId },
      payload: { pdfPath: relPath },
    })
    return success({ paper: next })
  })
}
