/**
 * Evidence-identity: the deterministic node-key normalization of the
 * evidence graph (v1.0 §2.4, v1.1 §2.3). A pure-function LEAF module —
 * the only import is `node:crypto`, so it can never participate in a
 * dependency cycle and every function is unit-testable without a ledger.
 *
 * Mimir's entities are already structured (arXiv ids key the papers table;
 * claims/ideas/experiments/projects carry UUIDs), so "entity normalization"
 * degenerates to deterministic key canonicalization: no LLM, no dictionary.
 * The one non-trivial pipeline is the TITLE FINGERPRINT — NFKC → lowercase
 * → punctuation/symbols to spaces → tokenize → CJK character-bigrams (a
 * single-character segment keeps its single character) → a minimal English
 * stopword filter → codepoint sort → sha256[:16]. English words and CJK
 * bigrams enter the SAME sort-and-hash pipeline, so mixed-language titles
 * unify naturally. Fingerprint values are sensitive to the stopword table
 * and the segmentation rule: ANY change there must bump
 * `EVIDENCE_GRAPH_DERIVATION_VERSION` (owned by `./evidence-graph.ts`) and
 * is disclosed in the view header (v1.1 risk note 7).
 *
 * Normalization failures are NEVER silently dropped: the fold layer counts
 * them in `stats.unnormalizable` (I2 — unestimable is not zero).
 * @module dsh-mimir/src/evidence-identity
 */

import { createHash } from 'node:crypto'

/** Hard cap of one node key (the service boundary rejects longer values). */
export const NODE_KEY_MAX_CHARS = 128
/** Hard cap of one display label (`srcLabel`/`dstLabel`). */
export const LABEL_MAX_CHARS = 160
/** Hard cap of one normalized alias value inside `keys`. */
export const ALIAS_MAX_CHARS = 256
/** Hard cap of the one-line human rationale (`note`, `reason`). */
export const NOTE_MAX_CHARS = 256

/** Hex digits of the title fingerprint (sha256 prefix). */
const TITLE_FP_HEX_CHARS = 16
/** Hex digits of the dedup key (sha256 prefix). */
const DEDUP_KEY_HEX_CHARS = 32
/** Hex digits of the retrieval-query node hash. */
const QUERY_KEY_HEX_CHARS = 12

/**
 * The minimal English stopword table of the title fingerprint (v1.1 §2.3,
 * ~30 words). Chinese builds no stopword table — bigrams dilute function
 * characters ("的/在/与" only ever appear joined to content characters), and
 * a Chinese bigram stoplist is explicitly deferred hardening.
 */
const TITLE_STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'on', 'in', 'for', 'and', 'or', 'to',
  'is', 'are', 'was', 'were', 'with', 'by', 'from', 'as', 'at', 'that',
  'this', 'it', 'its', 'their', 'our', 'your', 'not', 'no', 'vs', 'using',
  'based', 'via', 'toward', 'towards', 'into',
])

/** Query-tracking parameters stripped from normalized URLs. */
const STRIPPED_URL_PARAMS = /^(utm_|fbclid$|gclid$)/

/** DOI shape after the `https://doi.org/` prefix is stripped. */
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/

/** CJK runs inside a token (Han + kana + hangul), matched greedily. */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
/** Stateless CJK membership test (a /g regex's `.test` mutates `lastIndex`). */
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** Valid node-key kind prefix: a lowercase dotted-name-safe word. */
const NODE_KIND_PATTERN = /^[a-z][a-z0-9-]*$/

/** sha256 of one UTF-8 string, hex. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * The canonical node key for one entity: `<kind>:<raw>` (e.g. `claim:<uuid>`,
 * `lit:arxiv:<id>`). Throws a RangeError naming the offending field when the
 * kind is malformed or the raw value is empty or over the node-key cap —
 * callers at the service boundary translate that into `invalid-input`.
 * @param kind - the node kind (the key's prefix).
 * @param raw - the entity's stable id (a UUID, an arXiv id, a fingerprint).
 * @returns the canonical node key.
 */
export function nodeKeyOf(kind: string, raw: string): string {
  const cleanKind = kind.trim().toLowerCase()
  const value = raw.trim()
  if (!NODE_KIND_PATTERN.test(cleanKind)) {
    throw new RangeError(`node kind is invalid: ${kind}`)
  }
  if (value === '' || value.length > NODE_KEY_MAX_CHARS) {
    throw new RangeError(`node raw value is invalid: ${raw}`)
  }
  return `${cleanKind}:${value}`
}

/**
 * Whether one string already IS a well-shaped node key (`<kind>:<value>`,
 * within the cap, no control characters). The service boundary validates
 * caller-supplied `src`/`dst` with this predicate before emitting.
 * @param key - the candidate node key.
 * @returns true when the shape is acceptable.
 */
export function isValidNodeKey(key: string): boolean {
  if (key.length === 0 || key.length > NODE_KEY_MAX_CHARS) return false
  const index = key.indexOf(':')
  if (index <= 0) return false
  const kind = key.slice(0, index)
  const value = key.slice(index + 1)
  if (!NODE_KIND_PATTERN.test(kind) || value.length === 0) return false
  return !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * The node kind prefix of one node key (`claim:<id>` → `claim`), or null
 * when the string is not a well-shaped node key.
 * @param key - the candidate node key.
 * @returns the kind prefix, or null.
 */
export function nodeKindOf(key: string): string | null {
  if (!isValidNodeKey(key)) return null
  const index = key.indexOf(':')
  return index > 0 ? key.slice(0, index) : null
}

/**
 * Normalize one URL for identity: lowercase protocol and host, drop the
 * default port, drop the fragment, drop trailing slashes, strip
 * `utm_*`/`fbclid`/`gclid` tracking parameters, and sort the remaining
 * parameters by name (stable within equal names). Only http/https URLs
 * normalize — anything else (and anything unparseable) returns null so the
 * fold can count it instead of guessing.
 * @param raw - the URL as it appeared at the decision moment.
 * @returns the canonical URL, or null when it cannot be normalized.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  const protocol = url.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  const isDefaultPort = url.port === ''
    || (protocol === 'https:' && url.port === '443')
    || (protocol === 'http:' && url.port === '80')
  const port = isDefaultPort ? '' : `:${url.port}`
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !STRIPPED_URL_PARAMS.test(name.toLowerCase()))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const search = params.length === 0
    ? ''
    : `?${params.map(([name, value]) => `${name}=${value}`).join('&')}`
  let pathname = url.pathname.replace(/\/+$/, '')
  if (pathname === '') pathname = '/'
  return `${protocol}//${host}${port}${pathname}${search}`
}

/**
 * Normalize one DOI: strip an optional `https://doi.org/` (or `dx.doi.org`)
 * resolver prefix, lowercase, and require the `10.<registrant>/<suffix>`
 * shape. Anything else returns null (counted, never guessed).
 * @param raw - the DOI string.
 * @returns the canonical DOI, or null when it cannot be normalized.
 */
export function normalizeDoi(raw: string): string | null {
  let value = raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase()
  if (value.length === 0 || value.length > ALIAS_MAX_CHARS) return null
  return DOI_PATTERN.test(value) ? value : null
}

/** Split one CJK segment into character bigrams (a 1-char segment keeps the char). */
function cjkBigrams(segment: string): readonly string[] {
  if (segment.length === 1) return [segment]
  const bigrams: string[] = []
  for (let index = 0; index < segment.length - 1; index += 1) {
    bigrams.push(segment.slice(index, index + 2))
  }
  return bigrams
}

/**
 * The title fingerprint (v1.1 §2.3, the eight-step pipeline): NFKC →
 * lowercase → punctuation/symbol (Unicode categories P and S) runs to
 * spaces → tokenize
 * on whitespace → per token, CJK runs become character bigrams (1-char
 * segments keep the single character) and non-CJK runs stay words → the
 * English stopword filter drops stopwords → codepoint sort → space join →
 * sha256, first 16 hex. Order-invariant by construction: two titles with
 * the same multiset of content tokens share one fingerprint.
 * @param title - the title as recorded (e.g. `literature.paper.imported`'s `payload.title`).
 * @returns the 16-hex fingerprint, or null when no content token survives.
 */
export function titleFingerprint(title: string): string | null {
  const spaced = title.normalize('NFKC').toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (spaced === '') return null
  const tokens: string[] = []
  for (const token of spaced.split(' ')) {
    if (token === '') continue
    if (!HAS_CJK.test(token)) {
      tokens.push(token)
      continue
    }
    // A CJK-bearing token splits into alternating non-CJK / CJK runs; the
    // CJK runs become bigrams, the non-CJK remainders stay word candidates.
    let cursor = 0
    for (const match of token.matchAll(CJK_RUN)) {
      const start = match.index ?? 0
      const before = token.slice(cursor, start)
      if (before !== '') tokens.push(before)
      tokens.push(...cjkBigrams(match[0]))
      cursor = start + match[0].length
    }
    const tail = token.slice(cursor)
    if (tail !== '') tokens.push(tail)
  }
  const kept = tokens.filter(token => token !== '' && !TITLE_STOPWORDS.has(token))
  if (kept.length === 0) return null
  return sha256Hex([...kept].sort().join(' ')).slice(0, TITLE_FP_HEX_CHARS)
}

/**
 * Whether one string already IS a title fingerprint (16 lowercase hex).
 * @param value - the candidate fingerprint.
 * @returns true when the shape matches.
 */
export function isTitleFingerprint(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value)
}

/**
 * The dedup key of one evidence-edge declaration: sha256 of the pipe-joined
 * `rel|src|dst|scope`, first 32 hex. Two declarations of the same relation
 * between the same nodes in the same scope share one key, so the fold merges
 * them (append-only idempotence) and a retraction covers every duplicate at
 * once (dedupKey-level granularity, v1.1 §2.1 rule 4).
 * @param rel - the relation enum member.
 * @param src - the source node key (as declared, pre-alias-merge).
 * @param dst - the destination node key (as declared, pre-alias-merge).
 * @param scope - the scope string (the refs scope joined; '' when unscoped).
 * @returns the 32-hex dedup key.
 */
export function dedupKeyOf(rel: string, src: string, dst: string, scope: string): string {
  return sha256Hex(`${rel}|${src}|${dst}|${scope}`).slice(0, DEDUP_KEY_HEX_CHARS)
}

/**
 * Whether one string already IS a dedup key (32 lowercase hex) — the shape
 * predicate the retraction boundary validates `payload.dedupKey` against.
 * @param value - the candidate key.
 * @returns true when the shape matches.
 */
export function isDedupKey(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value)
}

/**
 * The retrieval-query node key: `query:<hash12(query|scope)>`. One query
 * (within a scope) always folds to the same node, so `retrieved-via` edges
 * accumulate per query without a query table.
 * @param query - the query text as it was issued.
 * @param scope - the scope string ('' when unscoped).
 * @returns the canonical query node key.
 */
export function queryKeyOf(query: string, scope: string): string {
  return `query:${sha256Hex(`${query}|${scope}`).slice(0, QUERY_KEY_HEX_CHARS)}`
}

/**
 * The scope string behind one dedup key: the refs scope fields joined in a
 * fixed order (projectId/ideaId/claimId, '' when absent). Every emitter —
 * the panel service and the wiki tool alike — builds the scope with THIS
 * function so two channels can never disagree on the hash input.
 * @param refs - the optional scope refs.
 * @returns the deterministic scope string.
 */
export function evidenceScopeOf(refs: {
  readonly projectId?: string | undefined
  readonly ideaId?: string | undefined
  readonly claimId?: string | undefined
}): string {
  return `${refs.projectId ?? ''}/${refs.ideaId ?? ''}/${refs.claimId ?? ''}`
}
