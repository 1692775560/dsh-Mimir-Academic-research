/**
 * Behavior tests for the BibTeX pure functions: the tolerant parser (brace/
 * quote/bare values, comments, @string skipping, malformed blocks), the
 * serializer's round-trip invariant, and the PaperRecord → @misc projection.
 */

import { describe, expect, it } from 'vitest'
import { bibKeyOf, entryFromPaper, parseBibtex, serializeBibtex } from '../src/bibtex.ts'
import type { PaperRecord } from '../src/types.ts'

describe('parseBibtex', () => {
  it('parses entries of any type with lowercased field names', () => {
    const entries = parseBibtex(`
@article{Vaswani2017Attention,
  AUTHOR = {Vaswani, Ashish and Shazeer, Noam},
  Title = {Attention Is All You Need},
  year = 2017,
}
@InProceedings{he2016deep, title={Deep Residual Learning}, booktitle={CVPR}, year={2016}}
@book{goodfellow2016deep, title = "Deep Learning", publisher = {MIT Press}}
`)
    expect(entries.map(entry => entry.type)).toEqual(['article', 'inproceedings', 'book'])
    expect(entries[0]).toMatchObject({
      key: 'Vaswani2017Attention',
      fields: { author: 'Vaswani, Ashish and Shazeer, Noam', title: 'Attention Is All You Need', year: '2017' },
    })
    expect(entries[1]?.fields.title).toBe('Deep Residual Learning')
    expect(entries[2]?.fields.publisher).toBe('MIT Press')
  })

  it('reads nested braces, quoted escapes, and bare month macros', () => {
    const entries = parseBibtex(`
@misc{a, title = {The {EgoSync} {\\"u}ber-model}, month = jan, note = "see \\" the docs"}
`)
    expect(entries[0]?.fields).toEqual({
      title: 'The {EgoSync} {\\"u}ber-model',
      month: 'jan',
      note: 'see \\" the docs',
    })
  })

  it('skips comments, @string, @preamble, and @comment blocks', () => {
    const entries = parseBibtex(`
% a leading comment
@string{cvpr = {CVPR}}
@preamble{"\\usepackage{amsfonts}"}
@comment{this whole block is ignored, even with @article{x, title={trap}} inside}
loose text between entries @ not an entry
@misc{real, title = {Kept}}
`)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.key).toBe('real')
  })

  it('survives a malformed block and keeps parsing after it', () => {
    const entries = parseBibtex('@article{broken, title = {never closed\n@misc{ok, title = {Fine}}}\n')
    expect(entries.map(entry => entry.key)).toEqual(['ok'])
  })

  it('parses an empty file to an empty list', () => {
    expect(parseBibtex('')).toEqual([])
    expect(parseBibtex('% only a comment\n')).toEqual([])
  })
})

describe('serializeBibtex round-trip', () => {
  it('parse(serialize(entries)) deep-equals the entries', () => {
    const entries = [
      { key: 'a', type: 'article', fields: { author: 'A and B', title: 'T1', year: '2024' } },
      { key: 'b', type: 'misc', fields: { title: 'Nested {Braces} stay', note: 'x # y' } },
      { key: 'c', type: 'inproceedings', fields: {} },
    ]
    expect(parseBibtex(serializeBibtex(entries))).toEqual(entries)
    // And the fixpoint: serializing the re-parse is byte-identical.
    const once = serializeBibtex(entries)
    expect(serializeBibtex(parseBibtex(once))).toBe(once)
  })

  it('serializes an empty list to an empty string', () => {
    expect(serializeBibtex([])).toBe('')
  })
})

describe('entryFromPaper', () => {
  const PAPER: PaperRecord = {
    arxivId: '2103.00020v2',
    title: 'EgoSync',
    authors: ['Alice Zhang', 'Bob Li'],
    summary: '…',
    url: 'https://arxiv.org/abs/2103.00020v2',
    notes: '  直接对标  ',
    tags: [],
    projectIds: [],
    addedAt: '2026-08-20T00:00:00.000Z',
    published: '2021-03-01T00:00:00.000Z',
  }

  it('builds an @misc entry keyed by the dot-free arXiv id', () => {
    const entry = entryFromPaper(PAPER)
    expect(entry.key).toBe('210300020v2')
    expect(entry.type).toBe('misc')
    expect(entry.fields).toEqual({
      author: 'Alice Zhang and Bob Li',
      title: 'EgoSync',
      year: '2021',
      eprint: '2103.00020v2',
      archivePrefix: 'arXiv',
      url: 'https://arxiv.org/abs/2103.00020v2',
    })
  })

  it('reads the publication year from published, never from addedAt (#219)', () => {
    // addedAt says 2026 (the day the wiki first saw the paper); the paper
    // was published in 2021 — the citation must say 2021.
    expect(entryFromPaper(PAPER).fields.year).toBe('2021')
    // No source publication date → no year at all, never the addedAt year.
    const { published: _dropped, ...undated } = PAPER
    expect(entryFromPaper(undated).fields.year).toBeUndefined()
  })

  it('never exports reading notes into the citation (#219)', () => {
    expect(entryFromPaper(PAPER).fields.note).toBeUndefined()
  })

  it('does not fabricate an arXiv identity or URL for Zotero-only records (#219)', () => {
    const zoteroOnly: PaperRecord = {
      arxivId: 'zotero-AB12CD34',
      title: 'A journal article',
      authors: ['Carol Wang'],
      summary: '',
      url: 'https://doi.org/10.1000/xyz123',
      notes: 'Imported from Zotero (item AB12CD34). DOI: 10.1000/xyz123.',
      tags: [],
      projectIds: [],
      addedAt: '2026-08-20T00:00:00.000Z',
      published: '2019',
      doi: '10.1000/xyz123',
    }
    const entry = entryFromPaper(zoteroOnly)
    expect(entry.fields.eprint).toBeUndefined()
    expect(entry.fields.archivePrefix).toBeUndefined()
    expect(entry.fields.url).toBe('https://doi.org/10.1000/xyz123')
    expect(entry.fields.doi).toBe('10.1000/xyz123')
    expect(entry.fields.year).toBe('2019')
  })

  it('omits fields the record does not know instead of inventing them (#219)', () => {
    const sparse: PaperRecord = {
      arxivId: 'zotero-WXYZ9999',
      title: 'Mystery preprint',
      authors: [],
      summary: '',
      url: '',
      notes: '',
      tags: [],
      projectIds: [],
      addedAt: '2026-08-20T00:00:00.000Z',
    }
    expect(entryFromPaper(sparse).fields).toEqual({ title: 'Mystery preprint' })
  })

  it('omits year when addedAt does not parse and note when empty', () => {
    const entry = entryFromPaper({ ...PAPER, addedAt: 'not-a-date', notes: ' ' })
    expect(entry.fields.note).toBeUndefined()
    // published still supplies the year even when addedAt is garbage.
    expect(entry.fields.year).toBe('2021')
  })

  it('round-trips a real-world entry through parse and serialize (#219)', () => {
    const text = `@article{vaswani2017attention,
  author = {Vaswani, Ashish and Shazeer, Noam},
  title = {Attention Is All You Need},
  year = {2017},
  journal = {Advances in Neural Information Processing Systems},
  doi = {10.48550/arXiv.1706.03762},
}`
    const entries = parseBibtex(text)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.fields.year).toBe('2017')
    expect(entries[0]?.fields.doi).toBe('10.48550/arXiv.1706.03762')
    expect(parseBibtex(serializeBibtex(entries))).toEqual(entries)
  })

  it('bibKeyOf strips every BibTeX-hostile character', () => {
    expect(bibKeyOf('2103.00020v2')).toBe('210300020v2')
    expect(bibKeyOf('cs/0301001')).toBe('cs0301001')
  })
})
