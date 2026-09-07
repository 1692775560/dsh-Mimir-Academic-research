/**
 * Regression locks for the two correctness bugs the L0 extraction exposed.
 *
 * Both bugs came from the same root cause — a rule that was stated in one
 * place and *copied* somewhere else, where the copy quietly diverged:
 *
 *  1. `CREATION_ACTIONS` has six members; `report-tier` and `moment-index`
 *     each carried a hand-written copy listing three. Every digest that
 *     imported a paper, saved a figure, or reordered a section under-reported
 *     its "新建" count.
 *  2. `deriveLines` counted every attributed event as evidence, so a line with
 *     one real event and five journal entries cleared the I2 floor and started
 *     emitting state claims — and the zero-weight entries diluted its
 *     dispersion and inflated its touched-session count on the way.
 *
 * The fixes route both rules through `vocabulary.ts`, so the divergence is no
 * longer constructible. These tests pin the corrected behaviour; if they fail,
 * a fold has started answering a vocabulary question for itself again.
 * @module dsh-mimir/tests/cbe-l0-regressions
 */

import { describe, expect, it } from 'vitest'
import { assembleDigest } from '../src/report-tier.ts'
import { deriveLines } from '../src/cognitive-map.ts'
import { deriveCuratedMoments } from '../src/moment-index.ts'
import { CREATION_ACTIONS } from '../src/vocabulary.ts'
import type { EventRecord } from '../src/types.ts'
import type { CbeWikiSnapshot } from '../src/cognitive-map.ts'

const WIKI: CbeWikiSnapshot = { ideas: [], claims: [], projects: [] }
const NOW = Date.parse('2026-08-27T00:00:00.000Z')
const SINCE = '2026-08-01T00:00:00.000Z'
const UNTIL = '2026-08-27T00:00:00.000Z'

/** One minimal ledger event (only the fields the folds read). */
function ev(ts: string, action: string, refs: Record<string, string> = {}): EventRecord {
  return {
    id: `${action}-${ts}`,
    ts,
    action,
    actor: { kind: 'user', id: 'u' },
    refs,
    payload: {},
  } as unknown as EventRecord
}

describe('the creation class is counted whole, never a hand-copied subset', () => {
  it('has the six members the vocabulary declares', () => {
    expect(CREATION_ACTIONS.size).toBe(6)
  })

  it('counts the three actions the old copies omitted', () => {
    const events = [
      ev('2026-08-10T09:00:00.000Z', 'literature.paper.imported'),
      ev('2026-08-11T09:00:00.000Z', 'figures.saved'),
      ev('2026-08-12T09:00:00.000Z', 'writing.paper.reordered'),
    ]
    const digest = assembleDigest({
      events, wiki: WIKI, papers: [], since: SINCE, until: UNTIL, tier: 'weekly', nowMs: NOW,
    })
    const creations = digest.overview.find(stat => stat.key === 'creations')
    // None of these three were in the hand-written list, so this was '0'.
    expect(creations?.value).toBe('3')
  })

  it('calls a burst of only literature imports a creation moment', () => {
    const moments = deriveCuratedMoments(
      [
        ev('2026-08-10T09:00:00.000Z', 'literature.paper.imported', { projectId: 'p1' }),
        ev('2026-08-10T09:05:00.000Z', 'literature.paper.imported', { projectId: 'p1' }),
        ev('2026-08-10T09:10:00.000Z', 'literature.paper.imported', { projectId: 'p1' }),
      ],
      SINCE,
      UNTIL,
    )
    expect(moments).toHaveLength(1)
    expect(moments[0]?.kind).toBe('creation')
  })
})

describe('a line is moved only by decision-grade events', () => {
  const window = { since: SINCE, until: UNTIL, projectId: null }

  it('does not let five journal entries buy a one-event line its voice', () => {
    const events = [
      ev('2026-08-10T09:00:00.000Z', 'knowledge.idea.added', { ideaId: 'i1' }),
      ev('2026-08-11T09:00:00.000Z', 'journal.entry.added', { ideaId: 'i1' }),
      ev('2026-08-12T09:00:00.000Z', 'journal.entry.added', { ideaId: 'i1' }),
      ev('2026-08-13T09:00:00.000Z', 'journal.entry.added', { ideaId: 'i1' }),
      ev('2026-08-14T09:00:00.000Z', 'journal.entry.added', { ideaId: 'i1' }),
      ev('2026-08-15T09:00:00.000Z', 'journal.entry.added', { ideaId: 'i1' }),
    ]
    const line = deriveLines(events, WIKI, window, NOW).find(item => item.id === 'i1')
    // Six events are visible on the line, but only one is evidence.
    expect(line?.eventCount).toBe(6)
    expect(line?.tier).toBe('silent')
  })

  it('keeps a zero-weight touch visible but off the statistics', () => {
    const events = [
      ev('2026-08-02T00:00:00.000Z', 'knowledge.idea.added', { ideaId: 'i1' }),
      ev('2026-08-03T00:00:00.000Z', 'cbe.mainline.set', { ideaId: 'i1' }),
    ]
    const line = deriveLines(events, WIKI, window, NOW).find(item => item.id === 'i1')
    // The touch still registers as an event…
    expect(line?.eventCount).toBe(2)
    // …but a single weight-2 event has no spread, and no extra sitting.
    expect(line?.dispersion).toBe(0)
    expect(line?.returnSessions).toBe(1)
  })
})
