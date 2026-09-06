/**
 * Zotero Web API client (read-only): a connection probe, the collection
 * list, a full-text item search, a single-item read, and BibTeX export. The
 * JSON payloads are parsed with plain defensive handling (the API's item
 * shape is broad; only the fields the panel needs are read). The API key
 * rides the `Zotero-API-Key` header — it never enters a URL, a log line, or
 * an error message. Rate limiting (HTTP 429/503 with `Retry-After`) is
 * honored with exactly one delayed retry; the caller owns the abort/timeout
 * signal. Pure network in, structured data out — no fs, no wiki types.
 * @module dsh-mimir/src/tools/zotero
 */

/** Credentials of one Zotero user library (group libraries are out of scope). */
export interface ZoteroClientConfig {
  /** Web API key from zotero.org/settings/keys. */
  readonly apiKey: string
  /** Numeric user id shown on the same settings page. */
  readonly userId: string
}

/** Injectable fetch shape (tests substitute a mock; production uses the global). */
export type ZoteroFetch = (url: string, init: RequestInit) => Promise<Response>

/** One Zotero collection as the panel lists it. */
export interface ZoteroCollection {
  readonly key: string
  readonly name: string
  readonly itemCount: number
}

/** One Zotero item reduced to the fields the literature workbench shows. */
export interface ZoteroItem {
  readonly key: string
  readonly title: string
  /** Display names of the item's creators, in order. */
  readonly authors: string[]
  /** Four-digit publication year, or '' when the date does not carry one. */
  readonly year: string
  /** DOI, or '' when the item has none. */
  readonly doi: string
  /** Bare arXiv id recovered from `extra`/`url`, or null when absent. */
  readonly arxivId: string | null
  /** Journal/proceedings title, or '' for item types without one. */
  readonly publicationTitle: string
  /** Best external link: the item URL, else the DOI resolver link, else ''. */
  readonly url: string
}

/** One BibTeX export request: either explicit item keys or one collection. */
export type ZoteroBibRequest =
  | { readonly itemKeys: readonly string[]; readonly collectionKey?: undefined }
  | { readonly collectionKey: string; readonly itemKeys?: undefined }

/** The read-only client surface the Zotero domain module consumes. */
export interface ZoteroClient {
  /** Probe the credentials: resolves when the API accepts them, rejects otherwise. */
  readonly testConnection: (signal: AbortSignal) => Promise<void>
  /** List every collection of the configured user library. */
  readonly listCollections: (signal: AbortSignal) => Promise<ZoteroCollection[]>
  /** Full-text search (`qmode=everything`) capped at `limit` items. */
  readonly searchItems: (query: string, limit: number, signal: AbortSignal) => Promise<ZoteroItem[]>
  /** Read one item by key; rejects with HTTP 404's message for an unknown key. */
  readonly getItem: (key: string, signal: AbortSignal) => Promise<ZoteroItem>
  /** Export items as BibTeX text (paginated for collections). */
  readonly getItemsBibTeX: (request: ZoteroBibRequest, signal: AbortSignal) => Promise<string>
}

/** API base URL (a safety invariant, not a tunable). */
const ZOTERO_API_BASE = 'https://api.zotero.org'
/** Page size of one collection BibTeX export page (the API caps export formats at 150). */
const ZOTERO_BIB_PAGE_LIMIT = 100
/** Safety bound on the export pagination loop. */
const ZOTERO_BIB_MAX_PAGES = 50
/** Default wait before the single rate-limit retry when no usable Retry-After arrives. */
const ZOTERO_RETRY_DEFAULT_MS = 1000
/** Cap of the rate-limit wait (a panel action must not park for minutes). */
const ZOTERO_RETRY_MAX_MS = 10_000

/** Wait `ms`, rejecting early when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Milliseconds to wait before the retry, from the response's Retry-After header. */
function retryDelayMs(response: Response): number {
  const header = response.headers.get('retry-after')
  // `Number(null)` is 0 and `Number('')` is 0, and both pass a `>= 0` check,
  // so casting first made a 429 with no Retry-After retry immediately and
  // skip the default backoff entirely. Absence has to be decided before the
  // cast, not after it.
  if (header === null || header.trim() === '') {
    return ZOTERO_RETRY_DEFAULT_MS
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, ZOTERO_RETRY_MAX_MS)
  }
  // A non-numeric value is malformed rather than absent -- RFC 9110 also
  // allows an HTTP-date here, which this does not parse -- so it falls back
  // to the default too rather than being treated as zero.
  return ZOTERO_RETRY_DEFAULT_MS
}

/**
 * Run one authenticated GET against the Zotero API. A 429/503 (rate limited
 * or backing off) is retried exactly once after the response's Retry-After
 * wait; every non-OK status then rejects with status and URL (never the key).
 */
async function request(
  fetchImpl: ZoteroFetch,
  apiKey: string,
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  const init: RequestInit = { headers: { 'Zotero-API-Key': apiKey }, signal }
  let response = await fetchImpl(url, init)
  if (response.status === 429 || response.status === 503) {
    await sleep(retryDelayMs(response), signal)
    response = await fetchImpl(url, init)
  }
  if (!response.ok) {
    throw new Error(`zotero API request failed: HTTP ${String(response.status)} for ${url}`)
  }
  return response
}

/** Read one string field of a parsed JSON object, '' for anything else. */
function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name]
  return typeof value === 'string' ? value : ''
}

/** Recover a bare arXiv id from one item's `extra` field or URL, or null. */
function extractArxivId(extra: string, url: string): string | null {
  const candidates = [
    /arxiv:\s*([^\s\]]+)/i.exec(extra)?.[1],
    /arxiv\.org\/abs\/([^\s/?#]+)/i.exec(url)?.[1],
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const id = candidate.trim()
    if (/^[a-zA-Z0-9._/-]+$/.test(id)) return id
  }
  return null
}

/**
 * Reduce one raw Zotero API item to a {@link ZoteroItem}; undefined for
 * child items (attachments, notes) and malformed payloads.
 */
function parseItem(raw: unknown): ZoteroItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const envelope = raw as Record<string, unknown>
  const data = envelope.data
  if (typeof data !== 'object' || data === null) return undefined
  const fields = data as Record<string, unknown>
  const itemType = stringField(fields, 'itemType')
  if (itemType === 'attachment' || itemType === 'note') return undefined
  const key = stringField(envelope, 'key')
  if (key === '') return undefined
  const creators = Array.isArray(fields.creators) ? fields.creators : []
  const authors = creators.flatMap((creator): string[] => {
    if (typeof creator !== 'object' || creator === null) return []
    const record = creator as Record<string, unknown>
    const single = stringField(record, 'name')
    if (single !== '') return [single]
    const name = `${stringField(record, 'firstName')} ${stringField(record, 'lastName')}`.trim()
    return name === '' ? [] : [name]
  })
  const year = /\d{4}/.exec(stringField(fields, 'date'))?.[0] ?? ''
  const doi = stringField(fields, 'DOI')
  const itemUrl = stringField(fields, 'url')
  return {
    key,
    title: stringField(fields, 'title'),
    authors,
    year,
    doi,
    arxivId: extractArxivId(stringField(fields, 'extra'), itemUrl),
    publicationTitle: stringField(fields, 'publicationTitle'),
    url: itemUrl !== '' ? itemUrl : doi === '' ? '' : `https://doi.org/${doi}`,
  }
}

/** Parse one items-endpoint JSON body, dropping child/malformed items. */
function parseItems(body: string): ZoteroItem[] {
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(raw => {
    const item = parseItem(raw)
    return item === undefined ? [] : [item]
  })
}

/** Parse one collections-endpoint JSON body. */
function parseCollections(body: string): ZoteroCollection[] {
  const parsed: unknown = JSON.parse(body)
  if (!Array.isArray(parsed)) return []
  const collections: ZoteroCollection[] = []
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue
    const envelope = raw as Record<string, unknown>
    const data = envelope.data
    const meta = envelope.meta
    if (typeof data !== 'object' || data === null) continue
    const key = stringField(envelope, 'key')
    const name = stringField(data as Record<string, unknown>, 'name')
    if (key === '') continue
    const numItems = typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>).numItems
      : undefined
    collections.push({ key, name, itemCount: typeof numItems === 'number' ? numItems : 0 })
  }
  return collections
}

/**
 * Build the read-only Zotero Web API client for one configured user library.
 * @param config - API key and user id (from the plugin config).
 * @param fetchImpl - injectable fetch (tests); the ambient global otherwise,
 * resolved per call so a stubbed global applies.
 * @returns the client surface.
 */
export function createZoteroClient(config: ZoteroClientConfig, fetchImpl?: ZoteroFetch): ZoteroClient {
  const base = `${ZOTERO_API_BASE}/users/${encodeURIComponent(config.userId)}`
  const call = (url: string, signal: AbortSignal): Promise<Response> =>
    request(fetchImpl ?? globalThis.fetch, config.apiKey, url, signal)
  return {
    async testConnection(signal) {
      // One cheap authenticated read: 200 proves key + user id, 403/404 reject.
      await call(`${base}/collections?limit=1`, signal)
    },
    async listCollections(signal) {
      return parseCollections(await (await call(`${base}/collections?limit=100`, signal)).text())
    },
    async searchItems(query, limit, signal) {
      const url = `${base}/items?q=${encodeURIComponent(query)}&qmode=everything&limit=${String(limit)}`
      return parseItems(await (await call(url, signal)).text())
    },
    async getItem(key, signal) {
      const body = await (await call(`${base}/items/${encodeURIComponent(key)}`, signal)).text()
      const [item] = parseItems(`[${body}]`)
      if (item === undefined) throw new Error(`zotero item '${key}' is not a reference item`)
      return item
    },
    async getItemsBibTeX(bibRequest, signal) {
      if (bibRequest.itemKeys !== undefined) {
        if (bibRequest.itemKeys.length === 0) return ''
        const keys = bibRequest.itemKeys.map(key => encodeURIComponent(key)).join(',')
        return (await call(`${base}/items?format=bibtex&itemKey=${keys}`, signal)).text()
      }
      const chunks: string[] = []
      const collection = encodeURIComponent(bibRequest.collectionKey)
      let start = 0
      for (let page = 0; page < ZOTERO_BIB_MAX_PAGES; page += 1) {
        const url = `${base}/collections/${collection}/items?format=bibtex&limit=${String(ZOTERO_BIB_PAGE_LIMIT)}&start=${String(start)}`
        const response = await call(url, signal)
        const text = await response.text()
        if (text.trim() === '') break
        chunks.push(text)
        const total = Number(response.headers.get('total-results'))
        start += ZOTERO_BIB_PAGE_LIMIT
        if (!Number.isFinite(total) || start >= total) break
      }
      return chunks.join('\n')
    },
  }
}
