/**
 * The paper editor's completion grammar (#154): what the caret is inside of,
 * what the table offers for it, and what accepting a row does to the text.
 *
 * These are the tests the issue asks for — filtering as a pure function, all
 * three triggers — plus the two places this kind of feature usually breaks: a
 * caret in the middle of a line (not just at the end), and a `%` comment, where
 * completion is noise.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPLETION_LIMIT,
  LATEX_COMMANDS,
  LATEX_ENVIRONMENTS,
  applyCompletion,
  citationItemsOf,
  detectCompletion,
  filterCompletion,
} from '../src/client/completion.ts'
import type { BibEntry } from 'dsh-mimir/types'

/** Put the caret at the offset of `|` in the fixture and strip it. */
function at(marked: string): { source: string; caret: number } {
  const caret = marked.indexOf('|')
  return { source: `${marked.slice(0, caret)}${marked.slice(caret + 1)}`, caret }
}

function detect(marked: string): ReturnType<typeof detectCompletion> {
  const { source, caret } = at(marked)
  return detectCompletion(source, caret)
}

const ENTRIES: readonly BibEntry[] = Object.freeze([
  { key: 'vaswani2017attention', type: 'inproceedings', fields: { title: 'Attention Is All You Need' } },
  { key: 'he2016deep', type: 'inproceedings', fields: { title: 'Deep Residual Learning' } },
  { key: 'kingma2015adam', type: 'misc', fields: {} },
])

describe('detectCompletion', () => {
  it('reads a bare backslash as a command trigger with no prefix', () => {
    const trigger = detect('Text \\|')
    expect(trigger?.kind).toBe('command')
    expect(trigger?.prefix).toBe('')
    expect(trigger?.opener).toBe('\\')
  })

  it('reads the command prefix and starts the replacement at the backslash', () => {
    const trigger = detect('We use \\sect|')
    expect(trigger?.kind).toBe('command')
    expect(trigger?.prefix).toBe('sect')
    // The replacement starts right after the backslash, and ends at the caret.
    expect(trigger?.start).toBe(8)
    expect(trigger?.end).toBe(12)
  })

  it('reads \\begin{ as an environment trigger, not as the `begin` command', () => {
    const trigger = detect('\\begin{equ|')
    expect(trigger?.kind).toBe('environment')
    expect(trigger?.prefix).toBe('equ')
    expect(trigger?.opener).toBe('\\begin{')
    // The replacement is the name only: the braces stay.
    expect(trigger?.start).toBe(7)
  })

  it('reads \\end{ the same way', () => {
    const trigger = detect('\\end{align|')
    expect(trigger?.kind).toBe('environment')
    expect(trigger?.prefix).toBe('align')
    expect(trigger?.opener).toBe('\\end{')
  })

  it('reads a citation key and keeps the opener out of the replacement', () => {
    const trigger = detect('See \\cite{vasw|')
    expect(trigger?.kind).toBe('citation')
    expect(trigger?.prefix).toBe('vasw')
    expect(trigger?.opener).toBe('\\cite{')
    expect(trigger?.start).toBe(10)
  })

  it('reads the last key of a multi-key citation, after the comma and spaces', () => {
    const trigger = detect('\\citep[see][p.~3]{he2016deep,  king|')
    expect(trigger?.kind).toBe('citation')
    expect(trigger?.prefix).toBe('king')
    // Only the segment after the comma is replaced.
    expect(trigger?.start).toBe(31)
  })

  it('offers every key when the brace is empty', () => {
    const trigger = detect('\\cite{|')
    expect(trigger?.kind).toBe('citation')
    expect(trigger?.prefix).toBe('')
  })

  it('does not fire inside a % comment', () => {
    expect(detect('% see \\cite{vasw|')).toBeNull()
    expect(detect('% TODO \\sect|')).toBeNull()
  })

  it('still fires after an escaped percent sign', () => {
    const trigger = detect('50\\% of \\cite{he|')
    expect(trigger?.kind).toBe('citation')
    expect(trigger?.prefix).toBe('he')
  })

  it('does not fire on a line without a backslash before the caret', () => {
    expect(detect('plain words |')).toBeNull()
  })

  it('does not fire inside an argument that is not a completion site', () => {
    expect(detect('\\label{fig|')).toBeNull()
  })

  it('is stable when the caret sits mid-line rather than at the end', () => {
    const trigger = detect('\\sect|ion{Title}')
    expect(trigger?.kind).toBe('command')
    expect(trigger?.prefix).toBe('sect')
    expect(trigger?.end).toBe(5)
  })
})

describe('filterCompletion', () => {
  it('puts prefix matches before infix matches', () => {
    const values = filterCompletion(LATEX_COMMANDS, 'sec').map(item => item.value)
    // `section` starts with the prefix; `subsection` only contains it, and a
    // writer typing `\sec` means the sectioning command far more often.
    expect(values[0]).toBe('section')
    expect(values).toContain('subsection')
    expect(values.indexOf('section')).toBeLessThan(values.indexOf('subsection'))
  })

  it('is case-insensitive', () => {
    expect(filterCompletion(LATEX_COMMANDS, 'TEXT').map(item => item.value))
      .toEqual(filterCompletion(LATEX_COMMANDS, 'text').map(item => item.value))
  })

  it('returns every row for an empty prefix, shortest first', () => {
    const values = filterCompletion(LATEX_ENVIRONMENTS, '').map(item => item.value)
    expect(values.length).toBe(COMPLETION_LIMIT)
    expect(values[0]?.length).toBeLessThanOrEqual(values[values.length - 1]?.length ?? 0)
  })

  it('drops rows that match nothing', () => {
    expect(filterCompletion(LATEX_COMMANDS, 'zzzzzz')).toEqual([])
  })

  it('never returns the same value twice', () => {
    const duplicated = [...LATEX_COMMANDS, { value: 'section', detail: 'again' }]
    const values = filterCompletion(duplicated, 'section').map(item => item.value)
    expect(values.filter(value => value === 'section')).toHaveLength(1)
  })

  it('honours the caller limit', () => {
    expect(filterCompletion(LATEX_COMMANDS, '', 3)).toHaveLength(3)
  })
})

describe('citationItemsOf', () => {
  it('maps entries to key + title rows in file order', () => {
    expect(citationItemsOf(ENTRIES)).toEqual([
      { value: 'vaswani2017attention', detail: 'Attention Is All You Need' },
      { value: 'he2016deep', detail: 'Deep Residual Learning' },
      // No title: the entry type stands in rather than an empty column.
      { value: 'kingma2015adam', detail: 'misc' },
    ])
  })

  it('filters against the project bibliography, not a global one', () => {
    const items = citationItemsOf(ENTRIES)
    expect(filterCompletion(items, 'he2016').map(item => item.value)).toEqual(['he2016deep'])
  })
})

describe('applyCompletion', () => {
  it('replaces the trigger range and lands the caret after the value', () => {
    const { source, caret } = at('We use \\sect| here')
    const trigger = detectCompletion(source, caret)
    expect(trigger).not.toBeNull()
    if (trigger === null) return
    const edit = applyCompletion(source, trigger, 'section')
    expect(edit.source).toBe('We use \\section here')
    expect(edit.caret).toBe('We use \\section'.length)
  })

  it('keeps the braces when completing an environment name', () => {
    const { source, caret } = at('\\begin{equ|}\nx\n\\end{equation}')
    const trigger = detectCompletion(source, caret)
    if (trigger === null) throw new Error('no trigger')
    expect(applyCompletion(source, trigger, 'equation').source)
      .toBe('\\begin{equation}\nx\n\\end{equation}')
  })

  it('closes the brace a citation accept would otherwise leave open', () => {
    const { source, caret } = at('See \\cite{vasw|')
    const trigger = detectCompletion(source, caret)
    if (trigger === null) throw new Error('no trigger')
    const edit = applyCompletion(source, trigger, 'vaswani2017attention')
    // Without the closing brace the caret stays inside the citation cell, and
    // the next `\\section` would be read as another key.
    expect(edit.source).toBe('See \\cite{vaswani2017attention}')
    expect(edit.caret).toBe('See \\cite{vaswani2017attention}'.length)
  })

  it('does not add a second brace when one is already there', () => {
    const { source, caret } = at('See \\cite{vasw|}')
    const trigger = detectCompletion(source, caret)
    if (trigger === null) throw new Error('no trigger')
    expect(applyCompletion(source, trigger, 'vaswani2017attention').source)
      .toBe('See \\cite{vaswani2017attention}')
  })

  it('never adds a brace to a command accept', () => {
    const { source, caret } = at('\\sect|')
    const trigger = detectCompletion(source, caret)
    if (trigger === null) throw new Error('no trigger')
    expect(applyCompletion(source, trigger, 'section').source).toBe('\\section')
  })

  it('keeps an already-typed key of the same citation', () => {
    const { source, caret } = at('\\cite{he2016deep,kin|}')
    const trigger = detectCompletion(source, caret)
    if (trigger === null) throw new Error('no trigger')
    expect(applyCompletion(source, trigger, 'kingma2015adam').source)
      .toBe('\\cite{he2016deep,kingma2015adam}')
  })
})
