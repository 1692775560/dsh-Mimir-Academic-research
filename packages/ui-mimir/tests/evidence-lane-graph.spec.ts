/**
 * Behavior tests for the evidence lane-graph view-model: deterministic lane
 * assignment (first activity leftmost), global chronological rows, cross
 * claim wires, retract loops through the retracted edge's declaration,
 * conflict marks, and stable actor hues. Pure functions over frozen
 * fixtures — no DOM, no mocks.
 * @module dsh-client-ui-mimir/tests/evidence-lane-graph
 */

import { describe, expect, it } from 'vitest'
import type {
  EvidenceClaimHistory,
  EvidenceConflict,
  EvidenceGraphEdge,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'
import { actorHueOf, buildLaneGroups } from '../src/client/evidence-lane-graph.ts'

function entry(partial: Partial<EvidenceTimelineEntry> & { readonly sourceEventId: string; readonly ts: string }): EvidenceTimelineEntry {
  return Object.freeze({
    rel: 'supports',
    actor: { kind: 'panel', id: 'human' },
    note: null,
    retracted: false,
    ...partial,
  })
}

function claim(partial: Partial<EvidenceClaimHistory> & { readonly claimKey: string; readonly history: readonly EvidenceTimelineEntry[] }): EvidenceClaimHistory {
  return Object.freeze({
    claimLabel: partial.claimKey,
    status: null,
    supportsCount: 0,
    contradictsCount: 0,
    hasConflict: false,
    ...partial,
  })
}

function group(partial: Partial<EvidenceTimelineGroup> & { readonly key: string; readonly claims: readonly EvidenceClaimHistory[] }): EvidenceTimelineGroup {
  return Object.freeze({
    kind: 'idea',
    label: null,
    lastActiveAt: '2026-09-01T00:00:00.000Z',
    ...partial,
  })
}

function edge(partial: Partial<EvidenceGraphEdge> & { readonly id: string; readonly sourceEventId: string }): EvidenceGraphEdge {
  return Object.freeze({
    dedupKey: `dedup:${partial.id}`,
    rel: 'supports',
    src: 'lit:arxiv:2401.00001',
    dst: 'claim:c1',
    ts: '2026-09-01T00:00:00.000Z',
    actor: { kind: 'panel', id: 'human' },
    note: null,
    retracted: false,
    retractedAt: null,
    retractedBy: null,
    retractEventId: null,
    retractReason: null,
    scope: { projectId: null, ideaId: null, claimId: null },
    ...partial,
  })
}

describe('buildLaneGroups', () => {
  it('assigns one lane per claim ordered by first activity, rows globally chronological', () => {
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [
          claim({ claimKey: 'claim:late', history: [
            entry({ sourceEventId: 'e3', ts: '2026-09-03T10:00:00.000Z' }),
          ] }),
          claim({ claimKey: 'claim:early', history: [
            entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' }),
            entry({ sourceEventId: 'e4', ts: '2026-09-04T10:00:00.000Z', rel: 'contradicts' }),
          ] }),
        ],
      })],
      [],
      [],
    )
    expect(layout).toHaveLength(1)
    const lanes = layout[0]?.headers ?? []
    expect(lanes.map(lane => lane.claimKey)).toEqual(['claim:early', 'claim:late'])
    // Rows interleave the two lanes chronologically: e1(lane0) e3(lane1) e4(lane0).
    expect((layout[0]?.dots ?? []).map(dot => `${dot.id}@${dot.lane}:${dot.row}`))
      .toEqual(['e1@0:0', 'e3@1:1', 'e4@0:2'])
    expect(layout[0]?.rowCount).toBe(3)
  })

  it('ties rows deterministically by event id at equal timestamps', () => {
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [claim({ claimKey: 'claim:c1', history: [
          entry({ sourceEventId: 'b', ts: '2026-09-01T10:00:00.000Z' }),
          entry({ sourceEventId: 'a', ts: '2026-09-01T10:00:00.000Z' }),
        ] })],
      })],
      [],
      [],
    )
    expect((layout[0]?.dots ?? []).map(dot => dot.id)).toEqual(['a', 'b'])
  })

  it('wires a cross-claim source lane and skips non-claim sources', () => {
    const edges = [
      edge({ id: 'e1', sourceEventId: 'e1', src: 'claim:c2', dst: 'claim:c1' }),
      edge({ id: 'e2', sourceEventId: 'e2', src: 'lit:arxiv:2401.00002', dst: 'claim:c1', rel: 'cites' }),
    ]
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [
          claim({ claimKey: 'claim:c1', history: [
            entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' }),
            entry({ sourceEventId: 'e2', ts: '2026-09-02T10:00:00.000Z', rel: 'cites' }),
          ] }),
          claim({ claimKey: 'claim:c2', history: [
            entry({ sourceEventId: 'e9', ts: '2026-09-01T09:00:00.000Z' }),
          ] }),
        ],
      })],
      edges,
      [],
    )
    const wires = layout[0]?.wires ?? []
    expect(wires).toHaveLength(1)
    // Lanes sort by first activity: c2 (09:00) is lane 0, c1 is lane 1, and
    // e1's row is 1 (between e9@0 and e2@2).
    expect(wires[0]).toMatchObject({ kind: 'cross', fromLane: 0, toLane: 1, fromRow: 1, toRow: 1 })
  })

  it('omits the cross wire when the source claim has no lane in the group', () => {
    const edges = [edge({ id: 'e1', sourceEventId: 'e1', src: 'claim:elsewhere', dst: 'claim:c1' })]
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [claim({ claimKey: 'claim:c1', history: [
          entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' }),
        ] })],
      })],
      edges,
      [],
    )
    expect(layout[0]?.wires).toEqual([])
  })

  it('draws the retract loop back to the retracted declaration dot', () => {
    const edges = [
      edge({ id: 'e1', sourceEventId: 'e1', dst: 'claim:c1', retractEventId: 'r1', retracted: true, retractedAt: '2026-09-05T10:00:00.000Z' }),
    ]
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [claim({ claimKey: 'claim:c1', history: [
          entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z', retracted: true }),
          entry({ sourceEventId: 'r1', ts: '2026-09-05T10:00:00.000Z', rel: 'evidence.edge.retracted', retracted: true, note: 'wrong target' }),
        ] })],
      })],
      edges,
      [],
    )
    const dots = layout[0]?.dots ?? []
    expect(dots.map(dot => dot.shape)).toEqual(['hollow', 'diamond'])
    expect((layout[0]?.wires ?? [])).toHaveLength(1)
    expect((layout[0]?.wires ?? [])[0]).toMatchObject({ kind: 'retract', fromLane: 0, toLane: 0, fromRow: 0, toRow: 1 })
  })

  it('marks the active conflict pair dots', () => {
    const edges = [
      edge({ id: 'sup', sourceEventId: 'sup', rel: 'supports', dst: 'claim:c1' }),
      edge({ id: 'con', sourceEventId: 'con', rel: 'contradicts', dst: 'claim:c1' }),
    ]
    const conflicts: EvidenceConflict[] = [{
      nodeKey: 'claim:c1',
      supporting: edges[0] as EvidenceGraphEdge,
      contradicting: edges[1] as EvidenceGraphEdge,
    }]
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [claim({ claimKey: 'claim:c1', history: [
          entry({ sourceEventId: 'sup', ts: '2026-09-01T10:00:00.000Z', rel: 'supports' }),
          entry({ sourceEventId: 'con', ts: '2026-09-02T10:00:00.000Z', rel: 'contradicts' }),
        ] })],
      })],
      edges,
      conflicts,
    )
    expect((layout[0]?.dots ?? []).map(dot => dot.conflict)).toEqual([true, true])
    expect((layout[0]?.dots ?? []).map(dot => dot.relClass)).toEqual(['supports', 'contradicts'])
  })

  it('flags the first dot of every calendar date', () => {
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [claim({ claimKey: 'claim:c1', history: [
          entry({ sourceEventId: 'e1', ts: '2026-09-01T08:00:00.000Z' }),
          entry({ sourceEventId: 'e2', ts: '2026-09-01T20:00:00.000Z' }),
          entry({ sourceEventId: 'e3', ts: '2026-09-02T09:00:00.000Z' }),
        ] })],
      })],
      [],
      [],
    )
    expect((layout[0]?.dots ?? []).map(dot => dot.dateFirst)).toEqual([true, false, true])
  })

  it('keeps actor hues stable across rows and inputs', () => {
    expect(actorHueOf('panel', 'human')).toBe(actorHueOf('panel', 'human'))
    expect(actorHueOf('agent', 'review-1')).toBe(actorHueOf('agent', 'review-1'))
    expect(actorHueOf('panel', 'human')).toBeLessThan(6)
    const layout = buildLaneGroups(
      [group({
        key: 'idea:1',
        claims: [claim({ claimKey: 'claim:c1', history: [
          entry({ sourceEventId: 'e1', ts: '2026-09-01T08:00:00.000Z' }),
          entry({ sourceEventId: 'e2', ts: '2026-09-01T20:00:00.000Z', actor: { kind: 'agent', id: 'review-1' } }),
        ] })],
      })],
      [],
      [],
    )
    const dots = layout[0]?.dots ?? []
    expect(dots[0]?.actorHue).toBe(actorHueOf('panel', 'human'))
    expect(dots[1]?.actorHue).toBe(actorHueOf('agent', 'review-1'))
  })

  it('is deterministic for a given input (deep equal across runs)', () => {
    const timeline = [group({
      key: 'idea:1',
      claims: [claim({ claimKey: 'claim:c1', history: [
        entry({ sourceEventId: 'e1', ts: '2026-09-01T08:00:00.000Z' }),
        entry({ sourceEventId: 'r1', ts: '2026-09-02T08:00:00.000Z', rel: 'evidence.edge.retracted', retracted: true }),
      ] })],
    })]
    const edges = [edge({ id: 'e1', sourceEventId: 'e1', retractEventId: 'r1', retracted: true })]
    const first = buildLaneGroups(timeline, edges, [])
    const second = buildLaneGroups(timeline, edges, [])
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('returns an empty layout list for an empty timeline', () => {
    expect(buildLaneGroups([], [], [])).toEqual([])
  })
})
