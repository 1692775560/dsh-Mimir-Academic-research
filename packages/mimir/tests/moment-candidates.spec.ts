/**
 * Five-source moment-candidate tests (S9b): each source fires on its own
 * trigger and stays silent below its floor; same-anchor candidates merge
 * sources; the fold is deterministic, unranked, and time-ordered.
 * @module dsh-mimir/tests/moment-candidates.spec
 */

import { describe, expect, it } from 'vitest'
import {
  CBE_MOMENT_CONVERGENCE_LINES,
  CBE_MOMENT_RETURN_GAP_DAYS,
  CBE_MOMENT_LONG_SITTING_MIN_SESSIONS,
  deriveMomentCandidates,
} from '../src/moment-candidates.ts'
import { deriveCuratedMoments, MOMENT_PIN_ACTION } from '../src/moment-index.ts'
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

const FROM = Date.parse('2026-08-01T00:00:00Z')
const TO = Date.parse('2026-09-01T00:00:00Z')

describe('deriveMomentCandidates (five sources)', () => {
  it('burst: a creation-class sitting is proposed as creation', () => {
    const events = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-05T08:10:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
    ]
    const candidates = deriveMomentCandidates(events, FROM, TO)
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    const creation = candidates.find(c => c.kind === 'creation')
    expect(creation).toBeDefined()
    expect(creation?.sources).toContain('burst')
  })

  it('burst: a sitting below the floor with nothing significant is not proposed', () => {
    // Two plain non-creation, non-terminal events: below CBE_MOMENT_BURST_MIN_EVENTS
    // and nothing significant — just Tuesday.
    const events = [
      ev('2026-08-05T08:00:00Z', 'compute.job.settled', { ideaId: 'idea-a', jobId: 'j1', serverId: 's1' }, { status: 'running' }),
      ev('2026-08-05T08:10:00Z', 'compute.job.settled', { ideaId: 'idea-a', jobId: 'j2', serverId: 's1' }, { status: 'running' }),
    ]
    const candidates = deriveMomentCandidates(events, FROM, TO)
    // lane-opening (milestone) still fires for the line's first decision
    // events; but no burst-kind candidate may exist.
    expect(candidates.find(c => c.kind === 'burst')).toBeUndefined()
  })

  it('return-after-dormancy: fires after the gap, not before it', () => {
    const gapDays = CBE_MOMENT_RETURN_GAP_DAYS
    // Below the gap: the second event comes home too early — no return.
    const early = new Date(Date.parse('2026-07-10T00:00:00Z') + (gapDays - 1) * 86_400_000).toISOString()
    const events = [
      ev('2026-07-10T00:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev(early, 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
    ]
    const noReturn = deriveMomentCandidates(events, FROM, TO)
    expect(noReturn.find(c => c.sources.includes('return-after-dormancy'))).toBeUndefined()

    // Above the gap AND inside the fold window (FROM = 2026-08-01): the
    // return event must land in the window to be proposed.
    const late = new Date(Date.parse('2026-07-10T00:00:00Z') + (gapDays + 13) * 86_400_000).toISOString()
    const events2 = [
      ev('2026-07-10T00:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev(late, 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
    ]
    const withReturn = deriveMomentCandidates(events2, FROM, TO)
    expect(withReturn.find(c => c.sources.includes('return-after-dormancy'))).toBeDefined()
  })

  it('cross-line-convergence: needs the threshold of distinct decision lines', () => {
    const one = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-05T08:10:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
    ]
    expect(deriveMomentCandidates(one, FROM, TO).find(c => c.kind === 'convergence')).toBeUndefined()

    const many: EventRecord[] = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
    ]
    for (let i = 1; i < CBE_MOMENT_CONVERGENCE_LINES; i += 1) {
      many.push(ev(`2026-08-05T08:${String(10 * i).padStart(2, '0')}:00Z`, 'knowledge.idea.added', { ideaId: `idea-${String.fromCharCode(97 + i)}` }))
    }
    const candidates = deriveMomentCandidates(many, FROM, TO)
    const convergence = candidates.find(c => c.kind === 'convergence' || (c.sources.includes('cross-line-convergence') && c.kind === 'creation'))
    // When the same anchor merges with a burst-creation, the merged kind is
    // the ladder winner (creation), with convergence among its sources.
    expect(convergence?.sources.includes('cross-line-convergence')).toBe(true)
    expect(convergence?.stats.distinctLines).toBeGreaterThanOrEqual(CBE_MOMENT_CONVERGENCE_LINES)
  })

  it('long-sitting: silent below the session floor, fires above the factor', () => {
    // Fewer than MIN_SESSIONS sittings → the source must not fire even when
    // one sitting is long.
    const few: EventRecord[] = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-05T12:00:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
    ]
    for (let i = 0; i < CBE_MOMENT_LONG_SITTING_MIN_SESSIONS - 2; i += 1) {
      few.push(ev(`2026-08-1${i}T09:00:00Z`, 'knowledge.claim.added', { ideaId: `idea-x${i}` }))
    }
    expect(deriveMomentCandidates(few, FROM, TO).find(c => c.sources.includes('long-sitting'))).toBeUndefined()

    // At/above the floor: four short single-event sittings (median span 0 →
    // source still silent: single-event sittings carry no span baseline),
    // then the floor met with real multi-event spans.
    const zeroMedian: EventRecord[] = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
    ]
    for (let i = 0; i < CBE_MOMENT_LONG_SITTING_MIN_SESSIONS; i += 1) {
      zeroMedian.push(ev(`2026-08-1${i}T09:00:00Z`, 'knowledge.claim.added', { ideaId: `idea-z${i}` }))
    }
    expect(deriveMomentCandidates(zeroMedian, FROM, TO).find(c => c.sources.includes('long-sitting'))).toBeUndefined()

    // Real spans: one long sitting as a dense chain (20-min steps stay inside
    // the 30-min session gap, so the sitting genuinely spans 4 hours), vs
    // several short two-event sittings (~10min each).
    const enough: EventRecord[] = []
    for (let step = 0; step <= 12; step += 1) {
      const minutes = String((step * 20) % 60).padStart(2, '0')
      const hour = 8 + Math.floor(step * 20 / 60)
      enough.push(ev(`2026-08-05T0${hour}:${minutes}:00Z`, step % 2 === 0 ? 'knowledge.idea.added' : 'literature.paper.imported', { ideaId: 'idea-a', paperId: `p${step}` }))
    }
    for (let i = 0; i < CBE_MOMENT_LONG_SITTING_MIN_SESSIONS; i += 1) {
      enough.push(ev(`2026-08-1${i}T09:00:00Z`, 'knowledge.claim.added', { ideaId: `idea-y${i}` }))
      enough.push(ev(`2026-08-1${i}T09:10:00Z`, 'literature.paper.imported', { ideaId: `idea-y${i}`, paperId: `pp-${i}` }))
    }
    expect(deriveMomentCandidates(enough, FROM, TO).find(c => c.sources.includes('long-sitting'))).toBeDefined()
  })

  it('milestone: a mainline move inside the window is proposed', () => {
    const events = [
      ev('2026-08-05T08:00:00Z', 'cbe.mainline.set', { ideaId: 'idea-a' }),
    ]
    const candidates = deriveMomentCandidates(events, FROM, TO)
    const milestone = candidates.find(c => c.sources.includes('milestone'))
    expect(milestone).toBeDefined()
    expect(milestone?.kind).toBe('milestone')
  })

  it('merges same-anchor candidates: sources union, kind ladder never downgrades', () => {
    // One sitting that is BOTH a creation burst and a cross-line convergence.
    const events = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-05T08:10:00Z', 'knowledge.idea.added', { ideaId: 'idea-b' }),
      ev('2026-08-05T08:20:00Z', 'literature.paper.imported', { ideaId: 'idea-b', paperId: 'p1' }),
    ]
    const candidates = deriveMomentCandidates(events, FROM, TO)
    // The anchor for burst (creation) and convergence (most significant) is
    // the same first creation event → merged.
    const merged = candidates.find(c => c.sources.length >= 2)
    expect(merged).toBeDefined()
    expect(merged?.sources).toContain('burst')
    expect(merged?.sources).toContain('cross-line-convergence')
    // creation outranks convergence on the shared ladder.
    expect(merged?.kind).toBe('creation')
  })

  it('closeness stays null while the eureka profile is silent (<3 declarations)', () => {
    const events = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-05T08:10:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
    ]
    const candidates = deriveMomentCandidates(events, FROM, TO)
    for (const candidate of candidates) {
      expect(candidate.closeness).toBeNull()
    }
  })

  it('is deterministic and time-ordered with no scoring fields', () => {
    const events = [
      ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' }),
      ev('2026-08-06T09:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-b' }),
      ev('2026-08-07T10:00:00Z', 'knowledge.idea.closed', { ideaId: 'idea-b' }, { reason: 'test' }),
    ]
    const first = deriveMomentCandidates(events, FROM, TO)
    const second = deriveMomentCandidates(events, FROM, TO)
    expect(first).toEqual(second)
    for (let i = 1; i < first.length; i += 1) {
      expect(first[i - 1]!.at.localeCompare(first[i]!.at)).toBeLessThanOrEqual(0)
    }
  })
})

describe('deriveCuratedMoments (index over the five sources)', () => {
  it('declines: a pinned:false on a never-canonical candidate marks declined, not removed', () => {
    const anchor = ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' })
    const events = [
      anchor,
      ev('2026-08-05T08:10:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
      // The researcher saw the candidate and refused it.
      ev('2026-08-06T09:00:00Z', MOMENT_PIN_ACTION, {}, { targetEventId: anchor.id, pinned: false }),
    ]
    const moments = deriveCuratedMoments(events, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')
    const declined = moments.find(m => m.id === anchor.id)
    expect(declined).toBeDefined()
    expect(declined?.pinned).toBe(false)
    expect(declined?.kind).not.toBe('pinned')
    expect(declined?.declined).toBe(true)
  })

  it('pin still promotes a candidate to canonical and a lone event to its own moment', () => {
    const anchor = ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' })
    const lone = ev('2026-08-20T10:00:00Z', 'compute.job.settled', { ideaId: 'idea-a', jobId: 'j1', serverId: 's1' }, { status: 'running' })
    const events = [
      anchor,
      ev('2026-08-05T08:10:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
      ev('2026-08-06T09:00:00Z', MOMENT_PIN_ACTION, {}, { targetEventId: anchor.id, note: 'the pivot' }),
      // A lonely plain event pinned directly.
      lone,
      ev('2026-08-20T11:00:00Z', MOMENT_PIN_ACTION, {}, { targetEventId: lone.id }),
    ]
    const moments = deriveCuratedMoments(events, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')
    const pinned = moments.find(m => m.id === anchor.id)
    expect(pinned?.kind).toBe('pinned')
    expect(pinned?.note).toBe('the pivot')
    const loneMoment = moments.find(m => m.id === lone.id)
    expect(loneMoment?.kind).toBe('pinned')
    expect(loneMoment?.eventCount).toBe(1)
    expect(loneMoment?.sources).toEqual([])
  })

  it('unpin (was canonical, then pinned:false) demotes the kind back, declined stays false', () => {
    const anchor = ev('2026-08-05T08:00:00Z', 'knowledge.idea.added', { ideaId: 'idea-a' })
    const events = [
      anchor,
      ev('2026-08-05T08:10:00Z', 'literature.paper.imported', { ideaId: 'idea-a', paperId: 'p1' }),
      ev('2026-08-06T09:00:00Z', MOMENT_PIN_ACTION, {}, { targetEventId: anchor.id, note: 'first' }),
      ev('2026-08-07T09:00:00Z', MOMENT_PIN_ACTION, {}, { targetEventId: anchor.id, pinned: false }),
    ]
    const moments = deriveCuratedMoments(events, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')
    const unpinned = moments.find(m => m.id === anchor.id)
    expect(unpinned?.pinned).toBe(false)
    // Demoted back to the candidate kind — and NOT marked declined, because
    // it was canonical before the pinned:false.
    expect(unpinned?.kind).not.toBe('pinned')
    expect(unpinned?.declined).toBe(false)
  })
})
