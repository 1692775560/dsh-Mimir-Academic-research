/**
 * Completion for the paper editor: LaTeX commands, environments, and the
 * project bibliography's `\cite` keys (#154).
 *
 * Everything here is pure — text in, text out — because the interesting part is
 * the trigger grammar, and that deserves tests that never touch a DOM: the
 * popover's geometry, the caret, and the bibliography fetch stay in
 * `PaperView.tsx`. The tables are static reference data, not i18n copy: a
 * usage snippet is language-free and is what the writer is actually reaching
 * for.
 */
import type { BibEntry } from 'dsh-mimir/types'

/** One candidate row: the text inserted, and the line shown beside it. */
export interface CompletionItem {
  readonly value: string
  readonly detail: string
}

/** Which table a trigger draws from. */
export type CompletionKind = 'command' | 'environment' | 'citation'

/** What the caret is inside of, and what a accepted row would replace. */
export interface CompletionTrigger {
  readonly kind: CompletionKind
  /** The literal that opened completion, shown as the popover's heading. */
  readonly opener: string
  /** Index of the first character an accepted value replaces. */
  readonly start: number
  /** Caret offset: the end of the replaced range. */
  readonly end: number
  /** Text already typed after the opener, which filters the table. */
  readonly prefix: string
}

/** The result of accepting a row: a new source and where the caret lands. */
export interface CompletionEdit {
  readonly source: string
  readonly caret: number
}

/** Rows rendered at once; the popover scrolls beyond this. */
export const COMPLETION_LIMIT = 8

/** Common commands, written as the usage a writer has to remember. */
export const LATEX_COMMANDS: readonly CompletionItem[] = Object.freeze([
  { value: 'section', detail: '\\section{title}' },
  { value: 'subsection', detail: '\\subsection{title}' },
  { value: 'subsubsection', detail: '\\subsubsection{title}' },
  { value: 'paragraph', detail: '\\paragraph{title}' },
  { value: 'title', detail: '\\title{title}' },
  { value: 'author', detail: '\\author{names}' },
  { value: 'maketitle', detail: '\\maketitle' },
  { value: 'abstract', detail: '\\begin{abstract} … \\end{abstract}' },
  { value: 'textbf', detail: '\\textbf{bold}' },
  { value: 'textit', detail: '\\textit{italic}' },
  { value: 'texttt', detail: '\\texttt{monospace}' },
  { value: 'emph', detail: '\\emph{emphasis}' },
  { value: 'underline', detail: '\\underline{text}' },
  { value: 'footnote', detail: '\\footnote{text}' },
  { value: 'cite', detail: '\\cite{key}' },
  { value: 'citep', detail: '\\citep{key}' },
  { value: 'citet', detail: '\\citet{key}' },
  { value: 'ref', detail: '\\ref{label}' },
  { value: 'eqref', detail: '\\eqref{label}' },
  { value: 'label', detail: '\\label{name}' },
  { value: 'begin', detail: '\\begin{environment}' },
  { value: 'end', detail: '\\end{environment}' },
  { value: 'item', detail: '\\item text' },
  { value: 'includegraphics', detail: '\\includegraphics[width=\\linewidth]{file}' },
  { value: 'caption', detail: '\\caption{text}' },
  { value: 'centering', detail: '\\centering' },
  { value: 'hline', detail: '\\hline' },
  { value: 'toprule', detail: '\\toprule' },
  { value: 'midrule', detail: '\\midrule' },
  { value: 'bottomrule', detail: '\\bottomrule' },
  { value: 'times', detail: '\\times' },
  { value: 'cdot', detail: '\\cdot' },
  { value: 'frac', detail: '\\frac{numerator}{denominator}' },
  { value: 'sqrt', detail: '\\sqrt{value}' },
  { value: 'sum', detail: '\\sum_{i}^{n}' },
  { value: 'prod', detail: '\\prod_{i}^{n}' },
  { value: 'int', detail: '\\int_{a}^{b}' },
  { value: 'partial', detail: '\\partial' },
  { value: 'nabla', detail: '\\nabla' },
  { value: 'alpha', detail: '\\alpha' },
  { value: 'beta', detail: '\\beta' },
  { value: 'gamma', detail: '\\gamma' },
  { value: 'lambda', detail: '\\lambda' },
  { value: 'mu', detail: '\\mu' },
  { value: 'sigma', detail: '\\sigma' },
  { value: 'theta', detail: '\\theta' },
  { value: 'mathcal', detail: '\\mathcal{L}' },
  { value: 'mathbb', detail: '\\mathbb{R}' },
  { value: 'mathrm', detail: '\\mathrm{d}' },
  { value: 'text', detail: '\\text{literal}' },
  { value: 'left', detail: '\\left( … \\right)' },
  { value: 'right', detail: '\\right)' },
  { value: 'newcommand', detail: '\\newcommand{\\name}{definition}' },
  { value: 'input', detail: '\\input{file}' },
  { value: 'bibliography', detail: '\\bibliography{references}' },
  { value: 'bibliographystyle', detail: '\\bibliographystyle{plain}' },
  { value: 'vspace', detail: '\\vspace{1em}' },
  { value: 'hspace', detail: '\\hspace{1em}' },
  { value: 'newpage', detail: '\\newpage' },
])

/** Common environments, offered inside `\begin{` and `\end{`. */
export const LATEX_ENVIRONMENTS: readonly CompletionItem[] = Object.freeze([
  { value: 'document', detail: 'the whole body' },
  { value: 'abstract', detail: 'abstract block' },
  { value: 'itemize', detail: 'bullet list' },
  { value: 'enumerate', detail: 'numbered list' },
  { value: 'description', detail: 'term list' },
  { value: 'figure', detail: 'floating figure' },
  { value: 'figure*', detail: 'two-column figure' },
  { value: 'table', detail: 'floating table' },
  { value: 'table*', detail: 'two-column table' },
  { value: 'tabular', detail: '\\begin{tabular}{l c r}' },
  { value: 'center', detail: 'centred block' },
  { value: 'equation', detail: 'numbered equation' },
  { value: 'equation*', detail: 'unnumbered equation' },
  { value: 'align', detail: 'aligned equations' },
  { value: 'align*', detail: 'aligned, unnumbered' },
  { value: 'gather', detail: 'gathered equations' },
  { value: 'cases', detail: 'piecewise definition' },
  { value: 'matrix', detail: 'matrix without delimiters' },
  { value: 'pmatrix', detail: 'parenthesised matrix' },
  { value: 'bmatrix', detail: 'bracketed matrix' },
  { value: 'verbatim', detail: 'literal text' },
  { value: 'minipage', detail: '\\begin{minipage}{width}' },
  { value: 'theorem', detail: 'theorem statement' },
  { value: 'proof', detail: 'proof block' },
])

/**
 * `\cite`-family commands, with the optional argument the family allows
 * (`\citep[see][p.~3]{key}`). Ordered longest-first is not needed: the pattern
 * is anchored at the caret, and `\cite` is a prefix of `\citep`, so the
 * alternation puts the longer names first.
 */
const CITE_OPENER = /\\(?:citealp|citeauthor|citeyear|parencite|textcite|autocite|nocite|citep|citet|cite)(?:\[[^\]]*\])*\{([^{}]*)$/
const ENVIRONMENT_OPENER = /\\(begin|end)\{([A-Za-z*]*)$/
const COMMAND_OPENER = /\\([A-Za-z]*)$/

/**
 * Whether the caret sits after an unescaped `%` on its own line — LaTeX's
 * comment marker, where completion would be noise.
 * @param source - the whole editor text.
 * @param caret - the caret offset.
 * @returns true when the rest of the line is commented out.
 */
function inComment(source: string, caret: number): boolean {
  const lineStart = source.lastIndexOf('\n', caret - 1) + 1
  let slashes = 0
  for (let index = lineStart; index < caret; index += 1) {
    const char = source[index]
    if (char === '\\') { slashes += 1; continue }
    if (char === '%' && slashes % 2 === 0) return true
    slashes = 0
  }
  return false
}

/**
 * Read what the caret is completing, if anything.
 *
 * The three grammars are tried most-specific first, because `\begin{` is also a
 * command prefix and `\cite{` is also a command. An empty prefix is a trigger:
 * `\` alone should list every command, `\cite{` every key.
 * @param source - the whole editor text.
 * @param caret - the caret offset into `source`.
 * @returns the trigger, or null when completion does not apply.
 */
export function detectCompletion(source: string, caret: number): CompletionTrigger | null {
  const at = Math.max(0, Math.min(caret, source.length))
  const before = source.slice(0, at)
  if (inComment(source, at)) return null

  const cite = CITE_OPENER.exec(before)
  if (cite !== null) {
    const inside = cite[1] ?? ''
    const comma = inside.lastIndexOf(',')
    const segment = inside.slice(comma + 1)
    const prefix = segment.trimStart()
    return Object.freeze({
      kind: 'citation' as const,
      opener: before.slice(cite.index, cite.index + cite[0].length - segment.length),
      start: at - prefix.length,
      end: at,
      prefix,
    })
  }

  const environment = ENVIRONMENT_OPENER.exec(before)
  if (environment !== null) {
    const prefix = environment[2] ?? ''
    return Object.freeze({
      kind: 'environment' as const,
      opener: `\\${environment[1] ?? 'begin'}{`,
      start: at - prefix.length,
      end: at,
      prefix,
    })
  }

  const command = COMMAND_OPENER.exec(before)
  if (command !== null) {
    const prefix = command[1] ?? ''
    return Object.freeze({
      kind: 'command' as const,
      opener: '\\',
      // The backslash stays put: an accepted value is the bare command name, so
      // only the letters after it are replaced (`\sec` + `section`).
      start: at - prefix.length,
      end: at,
      prefix,
    })
  }

  return null
}

/**
 * Rank the table against what has been typed: prefix matches before infix
 * matches, then shorter values first, then alphabetical. Case-insensitive
 * because LaTeX keys and commands are written inconsistently in practice.
 * @param items - the candidate table.
 * @param prefix - text typed after the opener.
 * @param limit - how many rows the popover shows.
 * @returns a frozen, de-duplicated, ordered list.
 */
export function filterCompletion(
  items: readonly CompletionItem[],
  prefix: string,
  limit = COMPLETION_LIMIT,
): readonly CompletionItem[] {
  const needle = prefix.toLowerCase()
  const seen = new Set<string>()
  const ranked: { item: CompletionItem; rank: number }[] = []
  for (const item of items) {
    if (seen.has(item.value)) continue
    seen.add(item.value)
    const haystack = item.value.toLowerCase()
    const rank = haystack.startsWith(needle) ? 0 : haystack.includes(needle) ? 1 : -1
    if (rank === -1) continue
    ranked.push({ item, rank })
  }
  ranked.sort((left, right) => left.rank - right.rank
    || left.item.value.length - right.item.value.length
    || left.item.value.localeCompare(right.item.value))
  return Object.freeze(ranked.slice(0, Math.max(0, limit)).map(entry => entry.item))
}

/**
 * The `\cite` candidates for a project's bibliography.
 * @param entries - the project's `references.bib` entries.
 * @returns key + title rows, in the file's order.
 */
export function citationItemsOf(entries: readonly BibEntry[]): readonly CompletionItem[] {
  return Object.freeze(entries.map(entry => Object.freeze({
    value: entry.key,
    detail: entry.fields.title ?? entry.fields.booktitle ?? entry.type,
  })))
}

/**
 * Replace the trigger's range with a chosen value.
 *
 * Accepting the last key of a citation closes the brace when the writer had not
 * typed one yet: leaving `\cite{vaswani2017attention` unclosed would keep the
 * caret inside a citation cell, where every following `\command` is read as
 * another key.
 * @param source - the whole editor text.
 * @param trigger - what `detectCompletion` returned.
 * @param value - the accepted row's value.
 * @returns the new source and the caret that follows the inserted text.
 */
export function applyCompletion(
  source: string,
  trigger: CompletionTrigger,
  value: string,
): CompletionEdit {
  const rest = source.slice(trigger.end)
  const closes = trigger.kind === 'citation' && (rest[0] ?? '') !== '}'
  const next = `${source.slice(0, trigger.start)}${value}${closes ? '}' : ''}${rest}`
  return Object.freeze({ source: next, caret: trigger.start + value.length + (closes ? 1 : 0) })
}
