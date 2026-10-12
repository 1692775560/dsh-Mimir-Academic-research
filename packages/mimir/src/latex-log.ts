/**
 * Pure parser for `latexmk -interaction=nonstopmode` logs. Extracts `! ...`
 * errors with their `l.<n>` line numbers, attributes issues to the innermost
 * open file tracked from the `(./file.tex ... )` push/pop trace, and collects
 * `LaTeX Warning:` / package warnings (including undefined citations) as
 * warnings. Line-wrapped log lines (the classical 79-column wrap) are not
 * re-joined; each wrapped message keeps its first line.
 * @module dsh-mimir/src/latex-log
 */

/** One diagnostic recovered from a LaTeX compile log. */
export interface LatexIssue {
  readonly severity: 'error' | 'warning'
  /** Innermost file open when the diagnostic was emitted, when known. */
  readonly file?: string
  /** 1-based input line, when the log states one. */
  readonly line?: number
  readonly message: string
}

/** Mutable accumulator while one error's `l.<n>` trailer is still pending. */
interface PendingError {
  file?: string
  message: string
  line?: number
}

/** Path-ish token after `(`: starts with `.`/`/`/drive letter, or carries a TeX-family extension. */
const FILE_TOKEN_RE = /^[a-zA-Z0-9_./:\\-]+$/
const FILE_TOKEN_EXT_RE = /\.(tex|sty|cls|clo|def|cfg|bib|aux|bbl|bst|out|toc|fd)$/
const ERROR_LINE_RE = /^!\s+(.*)$/
const ERROR_LINE_NO_RE = /^l\.(\d+)(?:\s|$)/
const WARNING_RE = /^(?:LaTeX|Package\s+\S+|Class\s+\S+)\s+Warning:\s+(.*)$/
const WARNING_LINE_NO_RE = /on input line (\d+)\.?\s*$/

/** Whether one `(`-delimited token names a file worth tracking on the stack. */
function isFileToken(token: string): boolean {
  if (token.length === 0 || !FILE_TOKEN_RE.test(token)) return false
  return token.startsWith('./') || token.startsWith('../') || token.startsWith('/') || FILE_TOKEN_EXT_RE.test(token)
}

/** The innermost currently open file; non-file `(` levels occupy null slots. */
function currentOpenFile(stack: readonly (string | null)[]): string | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index]
    if (entry !== null && entry !== undefined) return entry
  }
  return undefined
}

/** Scan one line, maintaining the open-file stack; every `(` pairs with a `)`. */
function trackFiles(line: string, stack: (string | null)[]): void {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '(') {
      const rest = line.slice(index + 1)
      const end = rest.search(/[\s()]/)
      const token = end === -1 ? rest : rest.slice(0, end)
      stack.push(isFileToken(token) ? token : null)
    } else if (char === ')') {
      if (stack.length > 0) stack.pop()
    }
  }
}

/** Strip the trailing line-number phrase from a warning's message. */
function warningMessage(raw: string): string {
  return raw.replace(/\s+on input line \d+\.?\s*$/, '').trim()
}

/**
 * Parse one compile log into ordered diagnostics.
 * @param log - Raw stdout/stderr text of the TeX run.
 * @returns errors and warnings in log order; an empty array means a clean log.
 */
export function parseLatexErrors(log: string): LatexIssue[] {
  const issues: LatexIssue[] = []
  const fileStack: (string | null)[] = []
  let pending: PendingError | undefined

  const flushPending = (): void => {
    if (pending === undefined) return
    const error: LatexIssue = {
      severity: 'error',
      message: pending.message,
      ...(pending.file === undefined ? {} : { file: pending.file }),
      ...(pending.line === undefined ? {} : { line: pending.line }),
    }
    issues.push(error)
    pending = undefined
  }

  // TeX engines on Windows emit CRLF logs; a bare \n split would leave a
  // trailing \r on every line and defeat the anchored regexes below (#267).
  for (const line of log.split(/\r?\n/)) {
    const currentFile = currentOpenFile(fileStack)

    const errorMatch = ERROR_LINE_RE.exec(line)
    if (errorMatch !== null) {
      flushPending()
      pending = {
        message: (errorMatch[1] ?? '').trim(),
        ...(currentFile === undefined ? {} : { file: currentFile }),
      }
      // An error line carries no file pushes we care about for itself.
      trackFiles(line, fileStack)
      continue
    }

    const lineNoMatch = ERROR_LINE_NO_RE.exec(line)
    if (lineNoMatch !== null && pending !== undefined) {
      pending.line = Number.parseInt(lineNoMatch[1] ?? '0', 10)
      flushPending()
      trackFiles(line, fileStack)
      continue
    }

    // Only a new error, a warning, an `l.<n>` trailer, or EOF closes an
    // error's trailer window: intervening helper lines (`<inserted text>`,
    // wrapped context) must not cost the error its line number.
    const warningMatch = WARNING_RE.exec(line)
    if (warningMatch !== null) {
      flushPending()
      const raw = warningMatch[1] ?? ''
      const warningLineNo = WARNING_LINE_NO_RE.exec(raw)
      const warning: LatexIssue = {
        severity: 'warning',
        message: warningMessage(raw),
        ...(currentFile === undefined ? {} : { file: currentFile }),
        ...(warningLineNo === null ? {} : { line: Number.parseInt(warningLineNo[1] ?? '0', 10) }),
      }
      issues.push(warning)
    }

    trackFiles(line, fileStack)
  }

  flushPending()
  return issues
}
