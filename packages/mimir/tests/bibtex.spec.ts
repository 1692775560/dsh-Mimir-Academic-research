/**
 * Behavior tests for the BibTeX pure functions: the tolerant parser (brace/
 * quote/bare values, comments, @string skipping, malformed blocks), the
 * serializer's round-trip invariant, and the PaperRecord → @misc projection.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bibKeyOf, entryFromPaper, parseBibtex, serializeBibtex } from '../src/bibtex.ts'
import type { PaperRecord } from '../src/types.ts'

/** Real-world sample kept byte-stable under `tests/fixtures/`. */
const REAL_WORLD_BIB = readFileSync(fileURLToPath(new URL('./fixtures/bibtex/real-world.bib', import.meta.url)), 'utf8')

describe('parseBibtex', () => {
  it('parses entries of any type with lowercased field names', () => {
    const entries = parseBibtex(REAL_WORLD_BIB)
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
  }

  it('builds an @misc entry keyed by the dot-free arXiv id', () => {
    const entry = entryFromPaper(PAPER)
    expect(entry.key).toBe('210300020v2')
    expect(entry.type).toBe('misc')
    expect(entry.fields).toEqual({
      author: 'Alice Zhang and Bob Li',
      title: 'EgoSync',
      year: '2026',
      eprint: '2103.00020v2',
      archivePrefix: 'arXiv',
      url: 'https://arxiv.org/abs/2103.00020v2',
      note: '直接对标',
    })
  })

  it('omits year when addedAt does not parse and note when empty', () => {
    const entry = entryFromPaper({ ...PAPER, addedAt: 'not-a-date', notes: ' ' })
    expect(entry.fields.year).toBeUndefined()
    expect(entry.fields.note).toBeUndefined()
  })

  it('bibKeyOf strips every BibTeX-hostile character', () => {
    expect(bibKeyOf('2103.00020v2')).toBe('210300020v2')
    expect(bibKeyOf('cs/0301001')).toBe('cs0301001')
  })
})
