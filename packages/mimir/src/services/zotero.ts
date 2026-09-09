/**
 * Zotero domain module: the read-only bridge between a configured Zotero
 * user library and the research wiki — connection probe, collection list,
 * full-text item search, single-item import into the papers table, and a
 * collection's BibTeX merged into a project's `references.bib`. Thin
 * forwarding of the `zotero.*` Remote methods lives in `service.ts`. The API
 * key only ever reaches the client (an HTTP header); it is never written to
 * the wiki, a log, or a result message. Without a configured key/user id
 * every method but the probe rejects `invalid-input` with configuration
 * guidance; the probe reports `unconfigured` instead (its job IS the status).
 * @module dsh-mimir/src/services/zotero
 */

import { parseBibtex } from '../bibtex.ts'
import { createZoteroClient } from '../tools/zotero.ts'
import type { ZoteroClientConfig, ZoteroItem } from '../tools/zotero.ts'
import type {
  ArxivEntry,
  PaperRecord,
  ResearchCheckZoteroResult,
  ResearchZoteroCollectionsResult,
  ResearchZoteroExportResult,
  ResearchZoteroImportResult,
  ResearchZoteroSearchResult,
} from '../types.ts'
import { rejected, success } from './common.ts'
import { importPaper } from './library.ts'
import { appendBibEntries } from './paper.ts'
import type { PaperDeps } from './paper.ts'

/** Everything the Zotero domain functions need from the service scope. */
export interface ZoteroDeps extends PaperDeps {
  /** Resolved Zotero knobs; absent (or empty) means the integration is off. */
  readonly zotero?: ZoteroClientConfig | undefined
}

/** Timeout of one Zotero API request made on the panel's behalf. */
const ZOTERO_FETCH_TIMEOUT_MS = 15_000
/** Default result cap of one panel-driven Zotero search. */
const ZOTERO_SEARCH_DEFAULT_MAX_RESULTS = 10
/** Hard result cap of one panel-driven Zotero search. */
const ZOTERO_SEARCH_MAX_RESULTS = 50
/** Papers-table id prefix of an imported item that carries no arXiv id. */
const ZOTERO_PAPER_ID_PREFIX = 'zotero-'

/** The failure every Zotero Remote method shares while the plugin config lacks credentials. */
const UNCONFIGURED = Object.freeze({
  code: 'invalid-input' as const,
  message: 'Zotero is not configured: set zotero.apiKey and zotero.userId in the mimir plugin config (cordis.yml); create a key at https://www.zotero.org/settings/keys',
})

/** The configured client, or the shared `invalid-input` rejection when unconfigured. */
function clientOf(deps: ZoteroDeps) {
  const config = deps.zotero
  if (config === undefined || config.apiKey.trim() === '' || config.userId.trim() === '') {
    return undefined
  }
  return createZoteroClient(config)
}

/** Map one settled client failure to the shared `operation-failed` branch. */
function failed(error: unknown, fallback: string) {
  return rejected({
    code: 'operation-failed',
    message: error instanceof Error ? error.message : fallback,
  })
}

/**
 * Probe the configured Zotero credentials. This method never rejects:
 * `unconfigured` (no key/user id in the plugin config), `ok` (the API
 * accepted a cheap authenticated read), or `failed` with the reason.
 * @param deps - open wiki domain and the resolved Zotero knobs.
 * @returns the settled connection status for the panel's Zotero section.
 */
export async function checkZotero(deps: ZoteroDeps): Promise<ResearchCheckZoteroResult> {
  const client = clientOf(deps)
  if (client === undefined) return success({ state: 'unconfigured' })
  try {
    await client.testConnection(AbortSignal.timeout(ZOTERO_FETCH_TIMEOUT_MS))
    return success({ state: 'ok' })
  } catch (error) {
    return success({
      state: 'failed',
      message: error instanceof Error ? error.message : 'zotero connection check failed',
    })
  }
}

/**
 * List the configured user library's collections (key, name, item count).
 * Unconfigured is `invalid-input`; transport/HTTP failures settle as
 * `operation-failed` with the underlying message.
 * @param deps - open wiki domain and the resolved Zotero knobs.
 * @returns the collections for the panel's export picker.
 */
export async function listZoteroCollections(deps: ZoteroDeps): Promise<ResearchZoteroCollectionsResult> {
  const client = clientOf(deps)
  if (client === undefined) return rejected(UNCONFIGURED)
  try {
    const collections = await client.listCollections(AbortSignal.timeout(ZOTERO_FETCH_TIMEOUT_MS))
    return success({ collections: Object.freeze(collections) })
  } catch (error) {
    return failed(error, 'zotero collection listing failed')
  }
}

/**
 * Search the configured user library on the panel's behalf. The query must
 * be non-empty (`invalid-input` otherwise); the request carries a hard 15s
 * timeout and failures settle as `operation-failed`.
 * @param deps - open wiki domain and the resolved Zotero knobs.
 * @param request - the free-text query and an optional result cap
 * (default 10, hard cap 50).
 * @returns the parsed items, the API's order preserved.
 */
export async function searchZotero(
  deps: ZoteroDeps,
  request: { query: string; maxResults?: number },
): Promise<ResearchZoteroSearchResult> {
  const client = clientOf(deps)
  if (client === undefined) return rejected(UNCONFIGURED)
  const query = request.query.trim()
  if (query === '') return rejected({ code: 'invalid-input', message: 'query must be non-empty' })
  const maxResults = request.maxResults ?? ZOTERO_SEARCH_DEFAULT_MAX_RESULTS
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > ZOTERO_SEARCH_MAX_RESULTS) {
    return rejected({ code: 'invalid-input', message: `maxResults must be an integer between 1 and ${ZOTERO_SEARCH_MAX_RESULTS}` })
  }
  try {
    const results = await client.searchItems(query, maxResults, AbortSignal.timeout(ZOTERO_FETCH_TIMEOUT_MS))
    return success({ results: Object.freeze(results) })
  } catch (error) {
    return failed(error, 'zotero search failed')
  }
}

/**
 * Import one Zotero item into the wiki's papers table. An item whose
 * `extra`/`url` yields an arXiv id rides the regular `importPaper` upsert
 * (keyed by the bare arXiv id); any other item lands under
 * `zotero-<item key>` with its provenance (Zotero key, DOI, URL) recorded in
 * the notes. Re-importing refreshes metadata but preserves the workbench's
 * notes, tags, and project links. A `projectId` links the paper to that
 * project (unknown id is `project-not-found`) — the workbench passes the
 * selected project so each project's literature view fills up on its own.
 * @param deps - open wiki domain and the resolved Zotero knobs.
 * @param request - the Zotero item key plus the optional project link.
 * @returns whether the paper was newly imported, plus its papers-table id.
 */
export async function importZoteroItem(
  deps: ZoteroDeps,
  request: { key: string; projectId?: string | undefined },
): Promise<ResearchZoteroImportResult> {
  const client = clientOf(deps)
  if (client === undefined) return rejected(UNCONFIGURED)
  const key = request.key.trim()
  if (key === '') return rejected({ code: 'invalid-input', message: 'key must be non-empty' })
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  let item: ZoteroItem
  try {
    item = await client.getItem(key, AbortSignal.timeout(ZOTERO_FETCH_TIMEOUT_MS))
  } catch (error) {
    return failed(error, 'zotero item fetch failed')
  }
  if (item.title.trim() === '') {
    return rejected({ code: 'invalid-input', message: `zotero item '${key}' has no title` })
  }
  if (item.arxivId !== null) {
    // The arXiv path: hand a synthesized entry to the regular import upsert.
    const entry: ArxivEntry = {
      id: item.arxivId,
      title: item.title,
      authors: [...item.authors],
      summary: '',
      published: item.year === '' ? '' : `${item.year}-01-01T00:00:00Z`,
      url: `https://arxiv.org/abs/${item.arxivId}`,
    }
    const outcome = await importPaper(deps, { entry, projectId: request.projectId })
    if (!outcome.ok) return outcome
    return success({ imported: outcome.value.imported, paperId: item.arxivId })
  }
  const paperId = `${ZOTERO_PAPER_ID_PREFIX}${key}`
  const table = deps.domain.table('papers')
  const existing = table.get(paperId)
  const provenance = [
    `Imported from Zotero (item ${key}).`,
    item.doi === '' ? '' : `DOI: ${item.doi}.`,
    item.url === '' ? '' : `URL: ${item.url}.`,
  ].filter(line => line !== '').join(' ')
  const record: PaperRecord = {
    arxivId: paperId,
    title: item.title,
    authors: [...item.authors],
    summary: '',
    url: item.url,
    notes: existing?.notes ?? provenance,
    // A re-import refreshes the Zotero metadata but never wipes the
    // workbench-curated organization fields.
    tags: [...(existing?.tags ?? [])],
    projectIds: [...new Set([
      ...(existing?.projectIds ?? []),
      ...(request.projectId === undefined ? [] : [request.projectId]),
    ])],
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    // Source publication metadata rides the re-import refresh, like title.
    ...(item.year === '' ? {} : { published: item.year }),
    ...(item.doi === '' ? {} : { doi: item.doi }),
  }
  await table.put(paperId, record)
  return success({ imported: existing === undefined, paperId })
}

/**
 * Export one Zotero collection as BibTeX and merge it into the addressed
 * project's `references.bib`, skipping citation keys already present (the
 * merge itself rides the shared `appendBibEntries` lock). An empty or
 * unparseable export is a successful no-op.
 * @param deps - workspace root, open wiki domain, and the resolved Zotero knobs.
 * @param request - the selected project, the collection key, and an optional
 * explicit paper directory.
 * @returns the appended and the already-present citation keys, or
 * `invalid-input` (unconfigured), `operation-failed` (API), or the merge's
 * `project-not-found`/`paper-not-found`/`invalid-dir`.
 */
export async function exportZoteroCollectionToBib(
  deps: ZoteroDeps,
  request: { projectId: string; collectionKey: string; dir?: string | undefined },
): Promise<ResearchZoteroExportResult> {
  const client = clientOf(deps)
  if (client === undefined) return rejected(UNCONFIGURED)
  const collectionKey = request.collectionKey.trim()
  if (collectionKey === '') return rejected({ code: 'invalid-input', message: 'collectionKey must be non-empty' })
  let bibtex: string
  try {
    bibtex = await client.getItemsBibTeX(
      { collectionKey },
      AbortSignal.timeout(ZOTERO_FETCH_TIMEOUT_MS),
    )
  } catch (error) {
    return failed(error, 'zotero BibTeX export failed')
  }
  return appendBibEntries(deps, {
    projectId: request.projectId,
    entries: parseBibtex(bibtex),
    ...(request.dir === undefined ? {} : { dir: request.dir }),
  })
}
