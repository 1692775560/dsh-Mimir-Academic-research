/**
 * Behavior tests for the LaTeX log parser: error capture with line numbers and
 * file attribution, warning classification, file-stack tracking across nested
 * includes, and clean-log handling.
 */

import { describe, expect, it } from 'vitest'
import { parseLatexErrors } from '../src/latex-log.ts'

describe('parseLatexErrors', () => {
  it('returns an empty array for a clean log', () => {
    const log = [
      'This is pdfTeX, Version 3.14159265 (TeX Live 2024)',
      '(./main.tex',
      'Output written on main.pdf (3 pages, 91234 bytes).',
      'Transcript written on main.log.',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([])
  })

  it('captures an error with its l.<n> line and the innermost open file', () => {
    const log = [
      '(./main.tex',
      '(./sections/method.tex',
      'Some text before.',
      '! Undefined control sequence.',
      'l.12 \\bogusmacro',
      '                  ',
      ')',
      ')',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'error', file: './sections/method.tex', line: 12, message: 'Undefined control sequence.' },
    ])
  })

  it('attributes later errors to the enclosing file after a nested file closes', () => {
    const log = [
      '(./main.tex',
      '(./intro.tex',
      '! Missing $ inserted.',
      'l.4 x+y',
      ')',
      '! LaTeX Error: \\begin{document} ended by \\end{zzz}.',
      'l.30 \\end{zzz}',
      ')',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'error', file: './intro.tex', line: 4, message: 'Missing $ inserted.' },
      { severity: 'error', file: './main.tex', line: 30, message: 'LaTeX Error: \\begin{document} ended by \\end{zzz}.' },
    ])
  })

  it('keeps an error message when helper lines precede the l.<n> trailer', () => {
    const log = [
      '(./main.tex',
      '! Missing $ inserted.',
      '<inserted text>',
      '                $',
      'l.7 E = mc^2',
      ')',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'error', file: './main.tex', line: 7, message: 'Missing $ inserted.' },
    ])
  })

  it('flushes an error without a line number when the log ends its trailer', () => {
    const log = [
      '! Emergency stop.',
      '(job aborted, no legal \\end found)',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'error', message: 'Emergency stop.' },
    ])
  })

  it('collects LaTeX warnings with input line numbers', () => {
    const log = [
      '(./main.tex',
      'LaTeX Warning: Reference `sec:method\' on page 2 undefined on input line 15.',
      'LaTeX Warning: There were undefined references.',
      ')',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'warning', file: './main.tex', line: 15, message: 'Reference `sec:method\' on page 2 undefined' },
      { severity: 'warning', file: './main.tex', message: 'There were undefined references.' },
    ])
  })

  it('classifies undefined-citation warnings as warnings', () => {
    const log = [
      '(./main.tex',
      'LaTeX Warning: Citation `doe2024\' on page 1 undefined on input line 22.',
      ')',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'warning', file: './main.tex', line: 22, message: 'Citation `doe2024\' on page 1 undefined' },
    ])
  })

  it('collects package warnings', () => {
    const log = 'Package hyperref Warning: Token not allowed in a PDF string on input line 9.'
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'warning', line: 9, message: 'Token not allowed in a PDF string' },
    ])
  })

  it('ignores non-file parenthesized tokens when attributing files', () => {
    const log = [
      '(./main.tex (uint) some font info',
      '! Undefined control sequence.',
      'l.3 \\x',
      ')',
    ].join('\n')
    expect(parseLatexErrors(log)).toEqual([
      { severity: 'error', file: './main.tex', line: 3, message: 'Undefined control sequence.' },
    ])
  })
})

describe('parseLatexErrors with CRLF line endings (Windows, #267)', () => {
  const log = [
    'This is pdfTeX, Version 3.14159265 (MiKTeX 24.1)',
    '(./main.tex',
    '! LaTeX Error: File `missing.png\' not found.',
    'See the LaTeX manual or LaTeX Companion for explanation.',
    'l.42 \\includegraphics{missing.png}',
    'LaTeX Warning: Reference `fig:x\' on page 1 undefined on input line 15.',
    'Package hyperref Warning: Token not allowed in a PDF string on input line 9.',
    ')',
    'Output written on main.pdf (3 pages, 91234 bytes).',
  ].join('\r\n')

  it('recovers errors and warnings from a CRLF log', () => {
    const issues = parseLatexErrors(log)
    expect(issues.filter((issue) => issue.severity === 'error').length).toBe(1)
    expect(issues.filter((issue) => issue.severity === 'warning').length).toBe(2)
  })

  it('strips carriage returns from messages and keeps file and line attribution', () => {
    const issues = parseLatexErrors(log)
    for (const issue of issues) {
      expect(issue.message).not.toContain('\r')
    }
    expect(issues).toEqual([
      { severity: 'error', file: './main.tex', line: 42, message: 'LaTeX Error: File `missing.png\' not found.' },
      { severity: 'warning', file: './main.tex', line: 15, message: 'Reference `fig:x\' on page 1 undefined' },
      { severity: 'warning', file: './main.tex', line: 9, message: 'Token not allowed in a PDF string' },
    ])
  })

  it('parses a CRLF log identically to its LF counterpart', () => {
    expect(parseLatexErrors(log)).toEqual(parseLatexErrors(log.replace(/\r\n/g, '\n')))
  })
})
