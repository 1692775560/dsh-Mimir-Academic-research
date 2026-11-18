/**
 * Pure mapping between a Mimir library record and a Zotero write payload
 * (#151). No network, no fs, no wiki types beyond the entry shape below — the
 * HTTP half lives in `tools/zotero.ts` and the orchestration in
 * `services/zotero.ts`, so the part worth testing twice is the part with no
 * I/O in it.
 *
 * Two rules shape everything here:
 *
 * 1. A missing field degrades the item, it never fails the push. A paper with
 *    no title becomes a note rather than an error, because a library entry the
 *    user can open and fix beats a push that stops halfway.
 * 2. Identity is matched on arXiv id, then DOI, then title. arXiv first because
 *    it is the id Mimir itself keys on; title last because it is the only one
 *    that can collide, and it is only reached when neither strong id exists.
 * @module dsh-mimir/src/zotero-push
 */

import type { ZoteroItem, ZoteroItemPayload } from './tools/zotero.ts'

/** One library record reduced to what the push needs. */
export interface PushEntry {
  /** Papers-table id, echoed back in failures so the panel can point at a row. */
  readonly paperId: string
  readonly title: string
  readonly authors: readonly string[]
  /** Four-digit year, or '' when the record carries no usable date. */
  readonly year?: string | undefined
  readonly doi?: string | undefined
  /** Bare arXiv id (version suffix allowed), or null when the record has none. */
  readonly arxivId?: string | null | undefined
  readonly url?: string | undefined
  readonly publicationTitle?: string | undefined
}

/** How one entry is looked up in the library before creating anything. */
export interface PushIdentity {
  readonly arxivId: string | null
  readonly doi: string | null
  /** Normalized title, or '' when the entry has no usable one. */
  readonly title: string
  /** The one query string handed to the search endpoint. */
  readonly query: string
}

/** Cap of one write batch (the Zotero API accepts 50 objects per request). */
const ZOTERO_WRITE_BATCH_SIZE = 50

/** Strip a `vN` suffix from an arXiv id. */
function bareArxivId(arxivId: string): string {
  return arxivId.trim().replace(/v\d+$/, '')
}

/** Lowercase, collapse whitespace, and drop trailing punctuation. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim()
}

/**
 * The identity the push matches on. The query string prefers the strongest
 * identifier available, because the search endpoint is full text: a title
 * search returns near-matches that `samePaper` then has to reject, while a DOI
 * search usually returns exactly the one item.
 * @param entry - the library record being pushed.
 * @returns the identifiers plus the single query to send.
 */
export function pushIdentityOf(entry: PushEntry): PushIdentity {
  const arxivId = entry.arxivId === undefined || entry.arxivId === null || entry.arxivId.trim() === ''
    ? null
    : bareArxivId(entry.arxivId)
  const doi = entry.doi === undefined || entry.doi.trim() === '' ? null : entry.doi.trim().toLowerCase()
  const title = normalizeTitle(entry.title)
  const query = arxivId ?? doi ?? entry.title.trim()
  return { arxivId, doi, title, query }
}

/**
 * Whether one library item already represents this entry. A match means
 * "skip": the push never rewrites an item the user may have curated in Zotero.
 * @param item - one parsed library item.
 * @param entry - the record being pushed.
 * @returns true when the two are the same work.
 */
export function samePaper(item: ZoteroItem, entry: PushEntry): boolean {
  const identity = pushIdentityOf(entry)
  if (identity.arxivId !== null && item.arxivId !== null
    && bareArxivId(item.arxivId) === identity.arxivId) {
    return true
  }
  if (identity.doi !== null && item.doi.trim().toLowerCase() === identity.doi) return true
  return identity.title !== '' && normalizeTitle(item.title) === identity.title
}

/** Split a display name into Zotero's two-field creator shape when possible. */
function creatorOf(name: string): Record<string, string> {
  const trimmed = name.trim()
  const split = /^(.+?)\s+(\S+)$/.exec(trimmed)
  if (split === null) return { creatorType: 'author', name: trimmed }
  return { creatorType: 'author', firstName: split[1] ?? '', lastName: split[2] ?? '' }
}

/**
 * The item body the write endpoint accepts for one entry.
 *
 * A record with no title becomes a `note` item carrying whatever the record
 * does have. That is the degradation the issue asks for: the alternative is to
 * reject the whole push because one row in the library is incomplete.
 * @param entry - the library record being pushed.
 * @param collectionKey - the collection the item lands in.
 * @returns one payload for `POST /users/<id>/items`.
 */
export function zoteroItemPayloadOf(entry: PushEntry, collectionKey: string): ZoteroItemPayload {
  const collections = [collectionKey]
  const title = entry.title.trim()
  if (title === '') {
    const lines = [entry.authors.join(', '), entry.doi ?? '', entry.url ?? '']
      .filter(line => line.trim() !== '')
    return { itemType: 'note', note: `<p>${lines.join(' — ')}</p>`, collections, tags: [] }
  }
  const year = (entry.year ?? '').trim()
  const doi = (entry.doi ?? '').trim()
  const arxivId = entry.arxivId === undefined || entry.arxivId === null ? '' : bareArxivId(entry.arxivId)
  const publicationTitle = (entry.publicationTitle ?? '').trim()
  const url = (entry.url ?? '').trim() !== ''
    ? (entry.url ?? '').trim()
    : arxivId === '' ? '' : `https://arxiv.org/abs/${arxivId}`
  // `extra` is where Zotero's own arXiv translators put the identifier, so an
  // item created here and one imported by the official tool look the same.
  const extra = arxivId === '' ? '' : `arXiv: ${arxivId}`
  return {
    itemType: publicationTitle === '' ? 'document' : 'journalArticle',
    title,
    creators: entry.authors.map(creatorOf),
    collections,
    tags: [],
    ...(year === '' ? {} : { date: year }),
    ...(doi === '' ? {} : { DOI: doi }),
    ...(url === '' ? {} : { url }),
    ...(publicationTitle === '' ? {} : { publicationTitle }),
    ...(extra === '' ? {} : { extra }),
  }
}

/**
 * Split payloads into the batches the write endpoint accepts, preserving order
 * so a per-item failure index maps back to the entry that produced it.
 * @param payloads - the payloads to send.
 * @returns consecutive batches of at most 50.
 */
export function batchPayloads(payloads: readonly ZoteroItemPayload[]): ZoteroItemPayload[][] {
  const batches: ZoteroItemPayload[][] = []
  for (let start = 0; start < payloads.length; start += ZOTERO_WRITE_BATCH_SIZE) {
    batches.push(payloads.slice(start, start + ZOTERO_WRITE_BATCH_SIZE))
  }
  return batches
}
