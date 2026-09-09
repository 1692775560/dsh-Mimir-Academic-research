/**
 * Dependency-free BibTeX parse/serialize for the workbench's bibliography
 * management, plus the PaperRecord → @misc projection used by the literature
 * import. The parser is deliberately a tolerant subset: any `@type` is kept
 * (article, inproceedings, misc, book, …), field names lowercase, both the
 * `{braced}` (nest-aware) and `"quoted"` value syntaxes read, bare tokens
 * (numbers, month macros) read as-is, and comments/`@string`/`@preamble`/
 * `@comment` blocks are skipped. Serialization always writes braced values —
 * parse(serialize(entries)) deep-equals entries (the round-trip invariant the
 * tests pin). Pure text in, structured data out — no fs, no wire types.
 * @module dsh-mimir/src/bibtex
 */

import type { PaperRecord } from './types.ts'

/** One parsed BibTeX entry. */
export interface BibEntry {
  /** Citation key (`\cite{key}`). */
  readonly key: string
  /** Lowercased entry type (`article`, `inproceedings`, `misc`, …). */
  readonly type: string
  /** Lowercased field names to raw values (braces/quotes stripped). */
  readonly fields: Record<string, string>
}

/** Entry types whose body is not a bibliography entry; skipped on parse. */
const SKIPPED_TYPES = new Set(['string', 'preamble', 'comment'])

/**
 * Read one field value starting at `start` (the first non-space character
 * after `=`): a brace group (nesting-aware), a quoted string (`\"` escape
 * aware), or a bare token up to the next `,`/`}`/`)`. Returns the raw inner
 * text and the index just past the value.
 */
function readValue(text: string, start: number): { value: string; end: number } | undefined {
  const opener = text[start]
  if (opener === '{') {
    let depth = 1
    let index = start + 1
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (char === '\\') index += 1 // an escaped character never toggles depth
      else if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      index += 1
    }
    if (depth !== 0) return undefined
    return { value: text.slice(start + 1, index - 1), end: index }
  }
  if (opener === '"') {
    let index = start + 1
    while (index < text.length) {
      const char = text[index]
      if (char === '\\') index += 2
      else if (char === '"') return { value: text.slice(start + 1, index), end: index + 1 }
      else index += 1
    }
    return undefined
  }
  // Bare token: digits, month macros, string references.
  const match = /^[^,}\)\s]+/.exec(text.slice(start))
  if (match === null) return undefined
  return { value: match[0], end: start + match[0].length }
}

/**
 * Parse one `@type{…}`/`@type(…)` block starting at the `@`. Returns the
 * entry (undefined for @string/@preamble/@comment) and the index just past
 * the closing delimiter, or undefined when the block is malformed — the
 * caller then skips ahead to the next `@`.
 */
function readEntry(text: string, at: number): { entry: BibEntry | undefined; end: number } | undefined {
  const head = /^@([a-zA-Z]+)\s*([{(])\s*/.exec(text.slice(at))
  if (head === null) return undefined
  const type = head[1]!.toLowerCase()
  const closer = head[2] === '{' ? '}' : ')'
  let index = at + head[0].length
  if (SKIPPED_TYPES.has(type)) {
    // Skip to the balanced closer; a @comment may carry no key at all.
    let depth = 1
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (char === '\\') index += 1
      else if (char === '{' || char === '(') depth += 1
      else if (char === '}' || char === ')') depth -= 1
      index += 1
    }
    return { entry: undefined, end: index }
  }
  const keyMatch = /^[^,\s}\)]+/.exec(text.slice(index))
  if (keyMatch === null) return undefined
  const key = keyMatch[0]
  index += key.length
  const fields: Record<string, string> = {}
  let closed = false
  while (index < text.length) {
    // Skip whitespace, commas, and in-entry comments (`%` to end of line).
    const skip = /^(?:\s|%[^\n]*|,)+/.exec(text.slice(index))
    if (skip !== null) index += skip[0].length
    const char = text[index]
    if (char === undefined) return undefined
    if (char === closer) { closed = true; index += 1; break }
    const nameMatch = /^[a-zA-Z][\w-]*\s*=\s*/.exec(text.slice(index))
    if (nameMatch === null) return undefined
    const name = nameMatch[0].replace(/[\s=]/g, '').toLowerCase()
    index += nameMatch[0].length
    const read = readValue(text, index)
    if (read === undefined) return undefined
    fields[name] = read.value
    index = read.end
    // A value may be followed by ` # macro` concatenation; re-reads merge.
    const concat = /^\s*#\s*/.exec(text.slice(index))
    if (concat !== null) {
      const next = readValue(text, index + concat[0].length)
      if (next === undefined) return undefined
      fields[name] += next.value
      index = next.end
    }
  }
  if (!closed) return undefined
  return { entry: { key, type, fields }, end: index }
}

/**
 * Parse a `.bib` text into its entries, in file order. Anything outside
 * `@entry` blocks is a comment by BibTeX rules and dropped; malformed blocks
 * are skipped rather than failing the whole file.
 * @param text - the `.bib` file content.
 * @returns the parsed entries.
 */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at === -1) break
    const read = readEntry(text, at)
    if (read === undefined) { index = at + 1; continue }
    if (read.entry !== undefined) entries.push(read.entry)
    index = Math.max(read.end, at + 1)
  }
  return entries
}

/**
 * Serialize entries back to `.bib` text: one blank line between entries,
 * two-space-indented braced fields in insertion order, trailing newline.
 * @param entries - the entries to write.
 * @returns the file content.
 */
export function serializeBibtex(entries: readonly BibEntry[]): string {
  return entries.map((entry) => {
    const fields = Object.entries(entry.fields)
      .map(([name, value]) => `  ${name} = {${value}},`)
      .join('\n')
    return fields === ''
      ? `@${entry.type}{${entry.key}}`
      : `@${entry.type}{${entry.key},\n${fields}\n}`
  }).join('\n\n') + (entries.length > 0 ? '\n' : '')
}

/** BibTeX-legal citation key of one arXiv id: dots and `v` separators out. */
export function bibKeyOf(arxivId: string): string {
  return arxivId.replace(/[^a-zA-Z0-9_-]/g, '')
}

/**
 * A real arXiv id: new-style `YYMM.NNNNN(vN)` or old-style
 * `archive/YYMMNNN(vN)`. Stricter than the path-safety predicate — a
 * Zotero-only record keyed `zotero-<item key>` is path-safe but is NOT an
 * arXiv paper, and the projection must not fabricate an arXiv identity for
 * it (#219).
 */
const ARXIV_ID_SHAPE = /^(\d{4}\.\d{4,5}(v\d+)?|[a-z-]+(\.[a-z]{2})?\/\d{7}(v\d+)?)$/

/**
 * Project one remembered literature paper into an `@misc` BibTeX entry.
 * Fields come from source metadata only: the year reads the record's
 * `published` (never `addedAt` — the wiki's first-sight day is not the
 * publication year), arXiv `eprint`/`archivePrefix` appear only for records
 * carrying a real arXiv id, `url` is the record's own link (the canonical
 * arXiv abstract URL only for arXiv records), and `doi` appears only when
 * the source supplied one. Reading notes stay in the workbench — they are
 * not publication metadata and never enter the exported citation (#219).
 * @param paper - the wiki paper record.
 * @returns the entry to append to `references.bib`.
 */
export function entryFromPaper(paper: PaperRecord): BibEntry {
  const fields: Record<string, string> = {}
  if (paper.authors.length > 0) fields.author = paper.authors.join(' and ')
  fields.title = paper.title
  const year = /\d{4}/.exec(paper.published ?? '')
  if (year !== null) fields.year = year[0]
  if (ARXIV_ID_SHAPE.test(paper.arxivId)) {
    fields.eprint = paper.arxivId
    fields.archivePrefix = 'arXiv'
    fields.url = paper.url === '' ? `https://arxiv.org/abs/${paper.arxivId}` : paper.url
  } else if (paper.url !== '') {
    fields.url = paper.url
  }
  if (paper.doi !== undefined && paper.doi !== '') fields.doi = paper.doi
  return { key: bibKeyOf(paper.arxivId), type: 'misc', fields }
}
