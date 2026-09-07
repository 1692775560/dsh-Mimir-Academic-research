/**
 * arXiv API tools: `arxiv_search` (query → paper list) and `paper_fetch`
 * (id → one paper). The Atom response is parsed with plain string handling;
 * both tools honor the execution's abort signal and reject on transport or
 * HTTP failure. {@link fetchArxivPdf} downloads one paper's PDF bytes for the
 * panel's literature workbench.
 * @module dsh-mimir/src/tools/arxiv
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isValidArxivId } from '../arxiv-id.ts'
import type { ResearchWikiDomain } from '../store.ts'
import type { ArxivEntry, PaperRecord, ProjectRecord } from '../types.ts'

/** One parsed arXiv entry, shared by both tools' output. */
export type { ArxivEntry } from '../types.ts'

/** Undo the small XML-entity vocabulary the arXiv Atom feed uses. */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Collapse the feed's pretty-printed whitespace inside one extracted field. */
function normalizeField(text: string): string {
  return unescapeXml(text).trim().replace(/\s+/g, ' ')
}

/** Extract the first `<name>...</name>` body from one entry block. */
function firstTag(block: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block)
  return match?.[1] === undefined ? '' : normalizeField(match[1])
}

/** Parse the Atom feed body into entries; a resultless feed yields `[]`. */
export function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = []
  const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
  for (const block of entryBlocks) {
    const rawId = firstTag(block, 'id')
    const id = rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '')
    if (id.length === 0) continue
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map(match => normalizeField(match[1] ?? ''))
      .filter(name => name.length > 0)
    entries.push({
      id,
      title: firstTag(block, 'title'),
      authors,
      summary: firstTag(block, 'summary'),
      published: firstTag(block, 'published'),
      url: `https://arxiv.org/abs/${id}`,
    })
  }
  return entries
}

/** Fetch one arXiv API URL, rejecting transport and HTTP failures as-is. */
async function fetchArxiv(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`arXiv API request failed: HTTP ${response.status} for ${url}`)
  }
  return response.text()
}

/** Optional knobs of one {@link fetchArxivSearch} call. */
export interface ArxivSearchOptions {
  /** Sort by submission date, newest first (default: the API's relevance order). */
  readonly sortBySubmittedDate?: boolean
}

/**
 * Run one arXiv full-text search and parse the feed. Shared by the
 * `arxiv_search` tool and the panel's `searchArxiv` Remote method; the caller
 * owns query validation and the abort/timeout signal.
 * @param query - free-text query matched against all fields.
 * @param maxResults - result cap forwarded to the API.
 * @param signal - abort/timeout signal of the caller.
 * @param options - sort order knobs (the subscription checker asks for the
 * newest submissions first).
 * @returns the parsed entries, `[]` for a resultless feed.
 */
export async function fetchArxivSearch(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  options: ArxivSearchOptions = {},
): Promise<ArxivEntry[]> {
  const sort = options.sortBySubmittedDate === true ? '&sortBy=submittedDate&sortOrder=descending' : ''
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}${sort}`
  return parseArxivFeed(await fetchArxiv(url, signal))
}

/** Hard cap of one downloaded paper PDF (a safety invariant, not a tunable). */
export const ARXIV_PDF_MAX_BYTES = 64 * 1024 * 1024

/**
 * Download one arXiv paper's PDF bytes. The id must be a bare arXiv id
 * (letters, digits, dots, dashes, slashes, and the `v` version suffix —
 * anything else is rejected before the request); transport, HTTP, empty, and
 * over-cap ({@link ARXIV_PDF_MAX_BYTES}) bodies all reject, the caller maps
 * them to its failure vocabulary.
 * @param arxivId - the bare arXiv id.
 * @param signal - abort/timeout signal of the caller.
 * @returns the PDF bytes.
 */
export async function fetchArxivPdf(arxivId: string, signal: AbortSignal): Promise<Uint8Array> {
  const id = arxivId.trim()
  if (!/^[a-zA-Z0-9._/-]+$/.test(id)) throw new Error(`invalid arXiv id: ${arxivId}`)
  const url = `https://arxiv.org/pdf/${id}`
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`arXiv PDF request failed: HTTP ${response.status} for ${url}`)
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > ARXIV_PDF_MAX_BYTES) {
    throw new Error(`arXiv PDF exceeds the ${String(ARXIV_PDF_MAX_BYTES)}-byte cap for ${url}`)
  }
  if (response.body === null) throw new Error(`arXiv returned an empty PDF body for ${url}`)
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > ARXIV_PDF_MAX_BYTES) {
      await reader.cancel()
      throw new Error(`arXiv PDF exceeds the ${String(ARXIV_PDF_MAX_BYTES)}-byte cap for ${url}`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  if (bytes.length === 0) throw new Error(`arXiv returned an empty PDF body for ${url}`)
  if (bytes.length < 5 || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    throw new Error(`arXiv returned a non-PDF body for ${url}`)
  }
  return bytes
}

/** File name (no directory) of one arXiv id's stored PDF; percent encoding keeps old-style slashes collision-free. */
export function paperPdfFileName(arxivId: string): string {
  return `${encodeURIComponent(arxivId)}.pdf`
}

export { isValidArxivId } from '../arxiv-id.ts'

/** JSON-schema properties of one {@link ArxivEntry} in tool output. */
const ENTRY_PROPERTIES = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  authors: { type: 'array', required: true, items: { type: 'string' } },
  summary: { type: 'string', required: true },
  published: { type: 'string', required: true },
  url: { type: 'string', required: true },
} as const

/** Render one entry list as model-facing text. */
function renderEntries(entries: readonly ArxivEntry[]): string {
  if (entries.length === 0) return 'No arXiv results.'
  return entries.map(entry =>
    `- ${entry.id}: ${entry.title}\n  Authors: ${entry.authors.join(', ')}\n  Published: ${entry.published}\n  ${entry.url}\n  ${entry.summary}`,
  ).join('\n')
}

/** Most recently touched project, used when a fetch omits an explicit id. */
function latestProject(domain: ResearchWikiDomain): ProjectRecord | undefined {
  let latest: ProjectRecord | undefined
  for (const [, project] of domain.table('projects').entries()) {
    if (latest === undefined || project.updatedAt > latest.updatedAt) latest = project
  }
  return latest
}

/**
 * Persist a deliberately fetched paper and associate it with the active
 * project. Re-fetching refreshes arXiv metadata while preserving the user's
 * organization, downloaded PDF, first-save timestamp, and prior notes.
 */
export async function rememberFetchedPaper(
  domain: ResearchWikiDomain,
  entry: ArxivEntry,
  options: { readonly projectId?: string; readonly notes?: string; readonly tags?: readonly string[] } = {},
): Promise<PaperRecord> {
  // The durable schema no longer hard-refines the id (a legacy bad row must
  // not abort the domain open), so every write path validates explicitly.
  if (!isValidArxivId(entry.id)) {
    throw new Error(`paper_fetch: unsafe arXiv id '${entry.id}'`)
  }
  const explicitProject = options.projectId === undefined ? undefined : domain.table('projects').get(options.projectId)
  if (options.projectId !== undefined && explicitProject === undefined) {
    throw new Error(`paper_fetch: no project with id '${options.projectId}'`)
  }
  const project = explicitProject ?? latestProject(domain)
  const table = domain.table('papers')
  const existing = table.get(entry.id)
  const incomingNotes = options.notes?.trim() ?? ''
  const notes = incomingNotes === '' || incomingNotes === existing?.notes
    ? (existing?.notes ?? '')
    : existing?.notes === '' || existing?.notes === undefined
      ? incomingNotes
      : `${existing.notes}\n\n${incomingNotes}`
  const record: PaperRecord = {
    arxivId: entry.id,
    title: entry.title,
    authors: [...entry.authors],
    summary: entry.summary,
    url: entry.url === '' ? `https://arxiv.org/abs/${entry.id}` : entry.url,
    notes,
    tags: [...new Set([...(existing?.tags ?? []), ...(options.tags ?? []).map(tag => tag.trim()).filter(Boolean)])],
    projectIds: [...new Set([...(existing?.projectIds ?? []), ...(project === undefined ? [] : [project.id])])],
    ...(existing?.pdfPath === undefined ? {} : { pdfPath: existing.pdfPath }),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  }
  await table.put(entry.id, record)
  return record
}

/**
 * Build the `arxiv_search` tool.
 * @param defaultMaxResults - Deployment default for the result cap.
 * @returns the registry-ready tool definition.
 */
export function createArxivSearchTool(defaultMaxResults: number): ToolDefinition {
  return defineTool({
    name: 'arxiv_search',
    description: 'Search arXiv for papers matching a free-text query. Returns ids, titles, authors, summaries, and URLs. When a result matters to the project, remember it with wiki_note action=add_paper so the workbench library stays current.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-text search query matched against all fields.' },
      max_results: { type: 'integer', description: `Maximum results to return (default ${defaultMaxResults}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: ENTRY_PROPERTIES },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderEntries(value.results) }],
    },
    async execute(args, exec) {
      const maxResults = args.max_results ?? defaultMaxResults
      if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
        throw new TypeError('max_results must be a positive integer')
      }
      return { results: await fetchArxivSearch(args.query, maxResults, exec.signal) }
    },
  })
}

/**
 * Build the `paper_fetch` tool.
 * @returns the registry-ready tool definition.
 */
export function createPaperFetchTool(domain: ResearchWikiDomain): ToolDefinition {
  return defineTool({
    name: 'paper_fetch',
    description: 'Fetch one useful arXiv paper by id and automatically save it to the Mimir literature library. It is linked to project_id when supplied, otherwise to the most recently active project.',
    parameters: {
      arxiv_id: { type: 'string', required: true, description: 'Bare arXiv id, with or without a version suffix.' },
      project_id: { type: 'string', description: 'Project to associate with the saved paper; defaults to the most recently updated project.' },
      notes: { type: 'string', description: 'Why this paper is useful; appended without erasing existing notes.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Organization tags merged into the saved paper.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: ENTRY_PROPERTIES },
      render: (_args, value) => [{ type: 'text', text: renderEntries([value]) }],
    },
    async execute(args, exec) {
      const id = args.arxiv_id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      if (id.length === 0) throw new Error('arxiv_id must be a non-empty arXiv id')
      const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`
      const [entry] = parseArxivFeed(await fetchArxiv(url, exec.signal))
      if (entry === undefined) throw new Error(`arXiv holds no record for id '${id}'`)
      await rememberFetchedPaper(domain, entry, {
        ...(args.project_id === undefined ? {} : { projectId: args.project_id }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
      })
      return entry
    },
  })
}
