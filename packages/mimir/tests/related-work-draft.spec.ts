/**
 * Tests for the citation cards and the related-work draft they assemble
 * (#153).
 *
 * The issue names two paths that must both work — a paper with working notes
 * and a paper without — plus the hard requirement that the `\cite` keys match
 * the project's bibliography exactly. All of that is decidable from the pure
 * functions, so this file needs no wiki and no `.bib`.
 */

import { describe, expect, it } from 'vitest'
import { authorsInline, buildRelatedWorkDraft, citationCardOf } from '../src/related-work.ts'
import { bibKeyOf } from '../src/bibtex.ts'
import type { PaperRecord } from '../src/types.ts'

function paper(overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    arxivId: '1706.03762v5',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    summary: 'The dominant sequence transduction models are based on complex recurrent networks. We propose the Transformer.',
    url: 'https://arxiv.org/abs/1706.03762v5',
    notes: '',
    tags: [],
    projectIds: [],
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('citationCardOf (#153)', () => {
  it('prefers working notes over the abstract', () => {
    const card = citationCardOf(paper({ notes: 'Drops recurrence entirely; scales with sequence length.' }))
    expect(card.source).toBe('notes')
    expect(card.sentence).toBe('Drops recurrence entirely; scales with sequence length.')
  })

  it('falls back to the abstract first sentence when there are no notes', () => {
    const card = citationCardOf(paper())
    expect(card.source).toBe('summary')
    expect(card.sentence).toBe('The dominant sequence transduction models are based on complex recurrent networks.')
  })

  it('falls back to the title when neither notes nor abstract exist', () => {
    const card = citationCardOf(paper({ notes: '   ', summary: '' }))
    expect(card.source).toBe('title')
    expect(card.sentence).toBe('Attention Is All You Need')
  })

  it('uses the same citation key rule as the bibliography', () => {
    for (const arxivId of ['1706.03762v5', 'cs/0601001', '2103.00020']) {
      expect(citationCardOf(paper({ arxivId })).key).toBe(bibKeyOf(arxivId))
    }
  })

  it('keeps an abbreviation inside its sentence instead of splitting on every period', () => {
    const card = citationCardOf(paper({ notes: 'We use e.g. beam search here. It is fast.' }))
    expect(card.sentence).toBe('We use e.g. beam search here.')
  })

  it('caps a runaway sentence and marks the elision', () => {
    const card = citationCardOf(paper({ notes: `${'a'.repeat(600)}.` }))
    expect(card.sentence.length).toBeLessThanOrEqual(400)
    expect(card.sentence.endsWith('…')).toBe(true)
  })

  it('collapses whitespace so a multi-line abstract reads as one sentence', () => {
    const card = citationCardOf(paper({ summary: 'First line\n   continues here. Second sentence.' }))
    expect(card.sentence).toBe('First line continues here.')
  })

  it('freezes the author list it hands out', () => {
    const card = citationCardOf(paper())
    expect(Object.isFrozen(card.authors)).toBe(true)
  })
})

describe('authorsInline', () => {
  it('spells out up to three names and abbreviates beyond', () => {
    expect(authorsInline(['A'])).toBe('A')
    expect(authorsInline(['A', 'B', 'C'])).toBe('A, B, C')
    expect(authorsInline(['A', 'B', 'C', 'D'])).toBe('A, B, C et al.')
    expect(authorsInline([])).toBe('Anon.')
  })
})

describe('buildRelatedWorkDraft (#153)', () => {
  const cards = [
    citationCardOf(paper({ arxivId: '1706.03762', notes: 'Drops recurrence entirely.' })),
    citationCardOf(paper({ arxivId: '1810.04805v2', title: 'BERT', notes: '', summary: 'We introduce BERT.' })),
  ]

  it('cites every card exactly once, with the bibliography key', () => {
    const draft = buildRelatedWorkDraft({ cards, missingBibKeys: [] })
    expect(draft.keys).toEqual(['170603762', '181004805v2'])
    for (const card of cards) {
      const cited = draft.text.split(`\\cite{${card.key}}`).length - 1
      expect(cited, card.key).toBe(1)
    }
    // The keys in the text are exactly the ones the library would write.
    expect(cards.map(card => card.key)).toEqual(['1706.03762', '1810.04805v2'].map(bibKeyOf))
  })

  it('opens with the draft marker so nobody mistakes it for authored prose', () => {
    const draft = buildRelatedWorkDraft({ cards, missingBibKeys: [] })
    expect(draft.text.split('\n')[0]).toContain('DRAFT')
    expect(draft.text.split('\n')[0]).toContain('Not inserted into main.tex')
    expect(draft.text).toContain('\\section{Related Work}')
  })

  it('lists the missing bib keys so the caller need not re-derive them', () => {
    const draft = buildRelatedWorkDraft({ cards, missingBibKeys: ['170603762'] })
    expect(draft.text).toContain('Missing bibliography entries (add these before compiling): 170603762')
    // The citation itself stays: a correct citation with a pending bib entry
    // is a fixable draft; a silently dropped one is a wrong draft.
    expect(draft.text).toContain('\\cite{170603762}')
  })

  it('carries the user hint as a comment, never as prose', () => {
    const draft = buildRelatedWorkDraft({ cards, missingBibKeys: [], hint: '  emphasise efficiency  ' })
    expect(draft.text).toContain('% Steer: emphasise efficiency')
    // Every line carrying the hint is a comment line, never body prose.
    const hintLines = draft.text.split('\n').filter(line => line.includes('emphasise efficiency'))
    expect(hintLines).toHaveLength(1)
    expect(hintLines[0]?.startsWith('%')).toBe(true)
  })

  it('drops a title-only card\'s author phrase but keeps its citation', () => {
    const titleOnly = citationCardOf(paper({ arxivId: '9999.00001', notes: '', summary: '' }))
    const draft = buildRelatedWorkDraft({ cards: [titleOnly], missingBibKeys: [] })
    expect(draft.text).toContain('Attention Is All You Need \\cite{999900001}')
    expect(draft.text).not.toContain('~\\cite')
  })

  it('still emits a compilable section for an empty selection', () => {
    const draft = buildRelatedWorkDraft({ cards: [], missingBibKeys: [] })
    expect(draft.text).toContain('\\section{Related Work}')
    expect(draft.text).toContain('No paper was selected')
    expect(draft.keys).toEqual([])
  })

  it('freezes the key list it hands out', () => {
    const draft = buildRelatedWorkDraft({ cards, missingBibKeys: [] })
    expect(Object.isFrozen(draft.keys)).toBe(true)
  })
})
