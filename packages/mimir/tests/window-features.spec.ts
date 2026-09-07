/**
 * Equivalence and boundary tests for the shared window-feature fold
 * (`window-features.ts`): the same ruler must measure a moment and a Eureka
 * lead-in identically, the EWS fields stay null below their own floor, and
 * the fold is deterministic and frozen.
 * @module dsh-mimir/tests/window-features.spec
 */

import { describe, expect, it } from 'vitest'
import { eurekaFeatures } from '../src/eureka.ts'
import { CBE_EWS_MIN_EVENTS } from '../src/ledger-ews.ts'
import { windowFeatures, type CbeWindowFeatures } from '../src/window-features.ts'
import type { EventRecord, LedgerActor, LedgerJsonValue } from '../src/types.ts'

const USER: LedgerActor = { kind: 'user', id: 'panel' }

let seq = 0
function ev(
  ts: string,
  action: string,
  refs: Partial<EventRecord['refs']> = {},
  payload: Record<string, LedgerJsonValue> = {},
): EventRecord {
  seq += 1
  return Object.freeze({
    id: `ev-${String(seq).padStart(3, '0')}`,
    ts,
    actor: USER,
    action,
    refs: Object.freeze(refs),
    payload: Object.freeze(payload),
  })
}

/** A mixed stream: creation, reading, compute, terminal — across two lines. */
function mixedStream(): readonly EventRecord[] {
  return [
    ev('2026-08-01T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }, { title: 'Alpha direction' }),
    ev('2026-08-01T08:20:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'pap-1' }, { title: 'Prior art' }),
    ev('2026-08-01T09:00:00Z', 'experiments.saved', { ideaId: 'idea-a', experimentId: 'exp-a1', projectId: 'p1' }, { name: 'run 1', created: true }),
    ev('2026-08-02T10:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-b' }, { title: 'Beta side road' }),
    ev('2026-08-03T10:00:00Z', 'literature.paper.imported', { ideaId: 'idea-b', paperId: 'pap-2' }, { title: 'Beta prior' }),
    ev('2026-08-03T11:00:00Z', 'compute.job.settled', { ideaId: 'idea-b', jobId: 'job-b1', serverId: 'srv1' }, { status: 'succeeded', exitCode: 0 }),
    ev('2026-08-04T12:00:00Z', 'knowledge.idea.closed', { ideaId: 'idea-b' }, { reason: 'superseded' }),
  ]
}

const FROM = Date.parse('2026-07-31T00:00:00Z')
const TO = Date.parse('2026-08-05T00:00:00Z')

describe('windowFeatures (shared fold)', () => {
  it('is field-for-field identical to eurekaFeatures over the same window', () => {
    for (const lineId of [null, 'idea-a', 'idea-b'] as const) {
      const shared = windowFeatures(mixedStream(), lineId, FROM, TO)
      const eureka = eurekaFeatures(mixedStream(), lineId, FROM, TO)
      expect(shared).toEqual(eureka)
    }
  })

  it('counts only the scoped line when a lineId is given', () => {
    const scoped = windowFeatures(mixedStream(), 'idea-a', FROM, TO)
    expect(scoped.eventCount).toBe(3)
    // idea-a's three actions (idea.added / paper.imported / experiments.saved)
    // are ALL creation-class per vocabulary.ts.
    expect(scoped.creationCount).toBe(3)
    const all = windowFeatures(mixedStream(), null, FROM, TO)
    expect(all.eventCount).toBe(7)
    // idea-b adds idea.added + paper.imported (creation); compute.job.settled
    // and idea.closed are not. 3 + 2 = 5.
    expect(all.creationCount).toBe(5)
  })

  it('treats the interval as half-open [from, to)', () => {
    const stream = [
      ev('2026-08-01T00:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-02T00:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-03T00:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
    ]
    const windowed = windowFeatures(stream, null, Date.parse('2026-08-01T00:00:00Z'), Date.parse('2026-08-03T00:00:00Z'))
    // The 08-01 event is IN (inclusive); the 08-03 event is OUT (exclusive).
    expect(windowed.eventCount).toBe(2)
  })

  it('folds an empty window to an honest zero vector with null EWS', () => {
    const folded = windowFeatures([], null, FROM, TO)
    expect(folded.eventCount).toBe(0)
    expect(folded.creationCount).toBe(0)
    expect(folded.sessionCount).toBe(0)
    expect(folded.netSignedWeight).toBe(0)
    expect(folded.distinctDays).toBe(0)
    expect(folded.unigramEntropy).toBeNull()
    expect(folded.conditionalEntropy).toBeNull()
    expect(folded.lag1MutualInformation).toBeNull()
    expect(folded.meanSurprisal).toBeNull()
  })

  it('keeps the EWS fields null below the symbol floor but counts honestly', () => {
    const few = mixedStream().slice(0, 3)
    const folded = windowFeatures(few, null, FROM, TO)
    expect(few.length).toBeLessThan(CBE_EWS_MIN_EVENTS)
    expect(folded.eventCount).toBe(3)
    expect(folded.unigramEntropy).toBeNull()
    expect(folded.conditionalEntropy).toBeNull()
  })

  it('carries real EWS readings above the floor', () => {
    // Build a stream above the floor: a repeating pattern with two actions.
    const events: EventRecord[] = []
    for (let i = 0; i < 20; i += 1) {
      const day = 1 + Math.floor(i / 4)
      const action = i % 2 === 0 ? 'knowledge.idea.added' : 'literature.paper.imported'
      events.push(ev(`2026-08-0${day}T0${i % 10}:00:00Z`, action, { ideaId: 'idea-a' }))
    }
    const folded = windowFeatures(events, null, FROM, TO)
    expect(folded.unigramEntropy).not.toBeNull()
    expect(folded.conditionalEntropy).not.toBeNull()
  })

  it('is deterministic and frozen', () => {
    const first = windowFeatures(mixedStream(), null, FROM, TO)
    const second = windowFeatures(mixedStream(), null, FROM, TO)
    expect(first).toEqual(second)
    expect(Object.isFrozen(first)).toBe(true)
  })
})

export type { CbeWindowFeatures }
