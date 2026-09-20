/**
 * Behavior tests for the meetings view's paper-picking helpers: the
 * project-scoped relevance sort, the default top-N pre-picks, and the
 * free-text filter over title/authors/tags.
 */

import { describe, expect, it } from 'vitest'
import type { PaperRecord } from 'dsh-mimir/types'
import {
  MEETING_DEFAULT_PAPER_PICKS,
  defaultMeetingPicks,
  filterMeetingPapers,
  sortMeetingPapers,
} from '../src/client/meeting-picks.ts'

/** One paper fixture; only the fields the helpers read. */
function paper(
  arxivId: string,
  projectIds: string[],
  score?: number,
  fields: { title?: string; authors?: string[]; tags?: string[] } = {},
): PaperRecord {
  return {
    arxivId,
    title: fields.title ?? arxivId,
    authors: fields.authors ?? [],
    summary: '',
    url: '',
    notes: '',
    tags: fields.tags ?? [],
    projectIds,
    addedAt: '2026-08-01T00:00:00Z',
    ...(score === undefined ? {} : { relevance: { p1: { score, reason: 'r', at: '2026-08-01T00:00:00Z' } } }),
  }
}

const LIBRARY = [
  paper('a', ['p1'], 4, { title: 'Mesh Recovery', authors: ['Doe, Jane'], tags: ['baseline'] }),
  paper('b', ['p1', 'p2'], 9, { title: 'EgoSync', authors: ['Roe, John'] }),
  paper('c', ['p1'], undefined, { title: 'Unscored Study' }),
  paper('d', ['p2'], 10),
  paper('e', ['p1'], 7),
  paper('f', ['p1'], 7),
  paper('g', ['p1'], 1),
]

describe('sortMeetingPapers', () => {
  it('keeps only the project’s papers, best relevance first, unscored last, ties stable', () => {
    expect(sortMeetingPapers(LIBRARY, 'p1').map(p => p.arxivId)).toEqual(['b', 'e', 'f', 'a', 'g', 'c'])
    expect(sortMeetingPapers(LIBRARY, 'p2').map(p => p.arxivId)).toEqual(['b', 'd'])
    expect(sortMeetingPapers(LIBRARY, 'ghost')).toEqual([])
  })
})

describe('defaultMeetingPicks', () => {
  it('pre-picks the relevance-sorted top N', () => {
    expect(defaultMeetingPicks(LIBRARY, 'p1')).toEqual(['b', 'e', 'f', 'a', 'g'])
    expect(defaultMeetingPicks(LIBRARY, 'p1', 2)).toEqual(['b', 'e'])
    expect(defaultMeetingPicks(LIBRARY, 'p2')).toEqual(['b', 'd'])
    expect(MEETING_DEFAULT_PAPER_PICKS).toBe(5)
  })

  it('shorter project lists pre-pick everything', () => {
    expect(defaultMeetingPicks([paper('x', ['p1'])], 'p1')).toEqual(['x'])
  })
})

describe('filterMeetingPapers', () => {
  it('passes everything on a blank query', () => {
    expect(filterMeetingPapers(LIBRARY, '')).toHaveLength(7)
    expect(filterMeetingPapers(LIBRARY, '   ')).toHaveLength(7)
  })

  it('matches title, authors, and tags case-insensitively', () => {
    expect(filterMeetingPapers(LIBRARY, 'mesh').map(p => p.arxivId)).toEqual(['a'])
    expect(filterMeetingPapers(LIBRARY, 'ROE').map(p => p.arxivId)).toEqual(['b'])
    expect(filterMeetingPapers(LIBRARY, 'baseline').map(p => p.arxivId)).toEqual(['a'])
    expect(filterMeetingPapers(LIBRARY, 'nope')).toEqual([])
  })
})
