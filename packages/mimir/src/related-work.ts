/**
 * Citation cards and the related-work draft they assemble (#153).
 *
 * Two pure steps, deliberately separated from the ssh/filesystem shell that
 * feeds them: a paper record becomes a {@link CitationCard}, and a list of
 * cards becomes a LaTeX draft. Everything that decides *what the draft says*
 * lives here, so the two cases the issue names — a paper with working notes
 * and a paper without — are testable without a wiki, a project, or a `.bib`.
 *
 * The draft is marked as a draft on its first line and never claims to be
 * finished prose: the whole point of the marker is that the panel inserts it
 * and a human edits it, and a `\section{Related Work}` that looks like authored
 * text is how an unreviewed summary ends up in a submission.
 *
 * @module dsh-mimir/src/related-work
 */

import { bibKeyOf } from './bibtex.ts'
import type { PaperRecord } from './types.ts'

/** Which field supplied a card's one-sentence contribution. */
export type CitationCardSource = 'notes' | 'summary' | 'title'

/** One paper, reduced to what a related-work sentence needs. */
export interface CitationCard {
  /** The citation key the project's bibliography uses (`bibKeyOf`'s rule). */
  readonly key: string
  readonly title: string
  readonly authors: readonly string[]
  /** One sentence of contribution, already stripped and length-capped. */
  readonly sentence: string
  /** Where `sentence` came from — notes outrank the abstract, which outranks the title. */
  readonly source: CitationCardSource
}

/** Longest contribution sentence kept; the rest is elided. */
const SENTENCE_MAX_CHARS = 400
/**
 * Longest author list spelled out before `et al.` takes over. Three names is
 * the point where a sentence stops reading as a sentence.
 */
const AUTHORS_INLINE_MAX = 3

/**
 * First sentence of one free-form block, or `''` when it holds none.
 *
 * Splitting on a period followed by whitespace keeps abbreviations such as
 * `e.g.` and decimals inside their sentence, which is the failure mode worth
 * avoiding: a card that reads "we use e.g." is worse than a longer one.
 * @param text - notes or an abstract.
 * @returns the first sentence, trimmed and length-capped.
 */
function firstSentenceOf(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return ''
  const boundary = /[.!?](\s|$)/g
  let cut = collapsed.length
  for (let match = boundary.exec(collapsed); match !== null; match = boundary.exec(collapsed)) {
    const token = /([A-Za-z.]+)$/.exec(collapsed.slice(0, match.index))?.[1] ?? ''
    // `e.g.`, `i.e.`, `et al.` and an author's initial all put a period or a
    // single letter right where a sentence would end. Skipping those tokens
    // keeps the sentence whole; the alternative — a card that reads
    // "We use e.g." — is worse than a card that runs long.
    if (token.includes('.') || token.length === 1) continue
    cut = match.index + 1
    break
  }
  const sentence = collapsed.slice(0, cut).trim()
  return sentence.length > SENTENCE_MAX_CHARS
    ? `${sentence.slice(0, SENTENCE_MAX_CHARS - 1)}…`
    : sentence
}

/**
 * Reduce one paper record to a citation card (#153).
 *
 * Degrades rather than fails: working notes carry the most specific claim and
 * win, the abstract is the fallback that always exists for an arXiv paper, and
 * a record with neither still yields the title — a citation with no claim is
 * still a correct citation, which is exactly the "质量降级，不是失败" the issue
 * asks for.
 * @param paper - the library record.
 * @returns the card.
 */
export function citationCardOf(paper: PaperRecord): CitationCard {
  const notes = firstSentenceOf(paper.notes)
  if (notes !== '') {
    return {
      key: bibKeyOf(paper.arxivId),
      title: paper.title,
      authors: Object.freeze([...paper.authors]),
      sentence: notes,
      source: 'notes',
    }
  }
  const summary = firstSentenceOf(paper.summary)
  if (summary !== '') {
    return {
      key: bibKeyOf(paper.arxivId),
      title: paper.title,
      authors: Object.freeze([...paper.authors]),
      sentence: summary,
      source: 'summary',
    }
  }
  return {
    key: bibKeyOf(paper.arxivId),
    title: paper.title,
    authors: Object.freeze([...paper.authors]),
    sentence: paper.title.trim(),
    source: 'title',
  }
}

/**
 * Spell one card's authors the way a sentence does: up to
 * {@link AUTHORS_INLINE_MAX} names, then `et al.`, and `Anon.` when the record
 * carries none.
 * @param authors - the card's author list.
 * @returns the inline author phrase.
 */
export function authorsInline(authors: readonly string[]): string {
  if (authors.length === 0) return 'Anon.'
  if (authors.length <= AUTHORS_INLINE_MAX) return authors.join(', ')
  return `${authors.slice(0, AUTHORS_INLINE_MAX).join(', ')} et al.`
}

/** Everything the assembler needs, so it can stay a pure function. */
export interface RelatedWorkDraftRequest {
  readonly cards: readonly CitationCard[]
  /** Keys the project's `.bib` does not carry; listed in the draft's tail comment. */
  readonly missingBibKeys: readonly string[]
  /** Optional one-line steer from the user ("emphasise efficiency work"). */
  readonly hint?: string | undefined
}

/** The assembled draft plus the facts about it a caller wants to assert on. */
export interface RelatedWorkDraft {
  /** The LaTeX text, draft marker first. */
  readonly text: string
  /** Citation keys the draft cites, in the order they appear. */
  readonly keys: readonly string[]
}

/**
 * Assemble the LaTeX related-work draft from citation cards (#153).
 *
 * One sentence per paper, each carrying its own `\cite{key}`, grouped under a
 * single `\section{Related Work}`. Deliberately *not* a themed narrative: a
 * machine grouping four abstracts into themes produces confident nonsense, and
 * the honest shape — every paper named once, the claim it makes next to it —
 * is what a human edits into a narrative. The last comment line lists the keys
 * whose `.bib` entry is missing, so the caller does not have to re-derive them.
 * @param request - the cards, the missing bib keys, and an optional hint.
 * @returns the draft text and the keys it cites.
 */
export function buildRelatedWorkDraft(request: RelatedWorkDraftRequest): RelatedWorkDraft {
  const keys = request.cards.map(card => card.key)
  const header: string[] = [
    '% DRAFT — generated from the research library; edit before use. Not inserted into main.tex.',
  ]
  if (request.hint !== undefined && request.hint.trim() !== '') {
    header.push(`% Steer: ${request.hint.trim()}`)
  }
  if (request.missingBibKeys.length > 0) {
    header.push(`% Missing bibliography entries (add these before compiling): ${request.missingBibKeys.join(', ')}`)
  }
  header.push('\\section{Related Work}')
  if (request.cards.length === 0) {
    header.push('% No paper was selected; the section is intentionally empty.')
    return { text: header.join('\n'), keys: Object.freeze(keys) }
  }
  const paragraphs = request.cards.map((card) => {
    const attribution = card.source === 'title'
      ? `\\cite{${card.key}}`
      : `${authorsInline(card.authors)}~\\cite{${card.key}}`
    return `${card.sentence} ${attribution}`
  })
  return { text: `${header.join('\n')}\n\n${paragraphs.join('\n\n')}`, keys: Object.freeze(keys) }
}
