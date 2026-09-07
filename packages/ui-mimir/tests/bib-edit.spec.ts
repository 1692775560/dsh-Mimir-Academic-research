/**
 * Tests for the bib entry editor's draft helpers: the entry → draft split
 * (common fields into their inputs, the rest as raw rows) and the draft →
 * entry assembly (trim, empty-row drops, last-write-wins merge).
 */

import { describe, expect, it } from 'vitest'
import { bibDraftFromEntry, bibEntryFromDraft, COMMON_BIB_FIELDS } from '../src/client/view-common.ts'

describe('bibDraftFromEntry', () => {
  it('splits common fields from the raw rows and keeps key and type', () => {
    const draft = bibDraftFromEntry({
      key: 'vaswani2017',
      type: 'inproceedings',
      fields: {
        title: 'Attention Is All You Need',
        author: 'Vaswani, Ashish and Shazeer, Noam',
        year: '2017',
        booktitle: 'NeurIPS',
        eprint: '1706.03762',
        archiveprefix: 'arXiv',
        url: 'https://arxiv.org/abs/1706.03762',
        note: 'baseline',
        pages: '5998--6008',
        doi: '10.48550/arXiv.1706.03762',
      },
    })
    expect(draft.key).toBe('vaswani2017')
    expect(draft.type).toBe('inproceedings')
    expect(draft.common['title']).toBe('Attention Is All You Need')
    expect(draft.common['year']).toBe('2017')
    expect(draft.extra).toEqual([
      { name: 'pages', value: '5998--6008' },
      { name: 'doi', value: '10.48550/arXiv.1706.03762' },
    ])
  })

  it('leaves common inputs absent (read as empty) for fields the entry lacks', () => {
    const draft = bibDraftFromEntry({ key: 'k', type: 'misc', fields: { title: 'T' } })
    expect(draft.common['title']).toBe('T')
    expect(draft.common['author']).toBeUndefined()
    expect(draft.extra).toEqual([])
  })
})

describe('bibEntryFromDraft', () => {
  it('assembles common fields in display order and appends the raw rows', () => {
    const entry = bibEntryFromDraft({
      key: 'k',
      type: 'Article',
      common: { author: 'Bob', title: 'Beta', year: '2023' },
      extra: [{ name: 'Pages', value: '1--9' }],
    })
    expect(entry).not.toBeNull()
    expect(entry?.type).toBe('article')
    expect(Object.keys(entry?.fields ?? {})).toEqual(
      [...COMMON_BIB_FIELDS.filter(name => ['title', 'author', 'year'].includes(name)), 'pages'],
    )
    expect(entry?.fields['pages']).toBe('1--9')
  })

  it('rejects an empty key or an empty type', () => {
    expect(bibEntryFromDraft({ key: '  ', type: 'misc', common: {}, extra: [] })).toBeNull()
    expect(bibEntryFromDraft({ key: 'k', type: '', common: {}, extra: [] })).toBeNull()
  })

  it('drops empty common inputs and empty-name or empty-value raw rows', () => {
    const entry = bibEntryFromDraft({
      key: 'k',
      type: 'misc',
      common: { title: 'T', author: '', year: '  ' },
      extra: [
        { name: '', value: 'orphan' },
        { name: 'doi', value: '' },
        { name: 'url2', value: 'x' },
      ],
    })
    expect(entry?.fields).toEqual({ title: 'T', url2: 'x' })
  })

  it('lets a raw row naming a common field override the form input', () => {
    const entry = bibEntryFromDraft({
      key: 'k',
      type: 'misc',
      common: { title: 'Form' },
      extra: [{ name: 'TITLE', value: 'Raw' }],
    })
    expect(entry?.fields['title']).toBe('Raw')
  })

  it('round-trips through the draft of the assembled entry', () => {
    const source = {
      key: 'k',
      type: 'misc',
      fields: { title: 'T', note: 'n', custom: 'c' },
    }
    const assembled = bibEntryFromDraft(bibDraftFromEntry(source))
    expect(assembled).toEqual(source)
  })
})
