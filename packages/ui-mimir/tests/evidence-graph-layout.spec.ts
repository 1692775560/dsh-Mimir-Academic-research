/**
 * Behavior tests for the evidence graph layout engine (PRD §84.1): band/rail
 * ordering, proportional time axis, monotonic x, same-timestamp stacking,
 * cross-claim inflow + external-source stubs, retract loops, conflict arcs,
 * Eureka placement, deterministic deep-equality, and fail-open edge cases.
 * Pure functions over frozen fixtures — no DOM, no mocks.
 * @module dsh-client-ui-mimir/tests/evidence-graph-layout
 */

import { describe, expect, it } from 'vitest'
import type {
  EvidenceClaimHistory,
  EvidenceConflict,
  EvidenceGraphEdge,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'
import {
  clipLabel,
  deriveEvidenceGraphLayout,
  EUREKA_FALLBACK_BAND,
  type EvidenceGraphLayoutInput,
} from '../src/client/evidence-graph-layout.ts'

function entry(partial: Partial<EvidenceTimelineEntry> & { readonly sourceEventId: string; readonly ts: string }): EvidenceTimelineEntry {
  return Object.freeze({ rel: 'supports', actor: { kind: 'panel', id: 'human' }, note: null, retracted: false, ...partial })
}
function claim(partial: Partial<EvidenceClaimHistory> & { readonly claimKey: string; readonly history: readonly EvidenceTimelineEntry[] }): EvidenceClaimHistory {
  return Object.freeze({ claimLabel: partial.claimKey, status: null, supportsCount: 0, contradictsCount: 0, hasConflict: false, ...partial })
}
function group(partial: Partial<EvidenceTimelineGroup> & { readonly key: string; readonly claims: readonly EvidenceClaimHistory[] }): EvidenceTimelineGroup {
  return Object.freeze({ kind: 'idea', label: null, lastActiveAt: '2026-09-06T00:00:00.000Z', ...partial })
}
function edge(partial: Partial<EvidenceGraphEdge> & { readonly id: string; readonly sourceEventId: string }): EvidenceGraphEdge {
  return Object.freeze({
    dedupKey: `dedup:${partial.id}`, rel: 'supports', src: 'lit:arxiv:2401.00001', dst: 'claim:c1',
    ts: '2026-09-01T00:00:00.000Z', actor: { kind: 'panel', id: 'human' }, note: null, retracted: false,
    retractedAt: null, retractedBy: null, retractEventId: null, retractReason: null,
    scope: { projectId: null, ideaId: null, claimId: null }, ...partial,
  })
}
function graph(partial: Partial<EvidenceGraphLayoutInput> & { readonly timeline: readonly EvidenceTimelineGroup[] }): EvidenceGraphLayoutInput {
  return { edges: [], conflicts: [], ...partial }
}

describe('deriveEvidenceGraphLayout', () => {
  it('orders bands and rails by first activity, top to bottom', () => {
    const layout = deriveEvidenceGraphLayout(graph({ timeline: [
      group({ key: 'idea:1', claims: [claim({ claimKey: 'claim:late', history: [entry({ sourceEventId: 'e3', ts: '2026-09-03T10:00:00.000Z' })] })] }),
      group({ key: 'idea:2', claims: [claim({ claimKey: 'claim:early', history: [entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' })] })] }),
    ] }))
    expect(layout.bands.map(band => band.key)).toEqual(['idea:2', 'idea:1'])
    const band2 = layout.bands[0]
    expect(band2?.claimKeys).toEqual(['claim:early'])
    expect(layout.rails[0]?.claimKey).toBe('claim:early')
    expect(layout.rails[0]?.y).toBeLessThan(layout.rails[1]?.y ?? Infinity)
  })

  it('keeps x monotonic in time and shares one column for equal timestamps', () => {
    const layout = deriveEvidenceGraphLayout(graph({ timeline: [group({
      key: 'idea:1',
      claims: [
        claim({ claimKey: 'claim:c1', history: [
          entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' }),
          entry({ sourceEventId: 'e2', ts: '2026-09-02T10:00:00.000Z' }),
        ] }),
        claim({ claimKey: 'claim:c2', history: [
          entry({ sourceEventId: 'e3', ts: '2026-09-01T10:00:00.000Z' }),
        ] }),
      ],
    })] }))
    const beads = layout.nodes.filter(node => node.kind === 'event')
    const e1 = beads.find(node => node.id === 'e1')
    const e2 = beads.find(node => node.id === 'e2')
    const e3 = beads.find(node => node.id === 'e3')
    expect(e2!.x).toBeGreaterThan(e1!.x)
    // Same timestamp ⇒ same column, different rails ⇒ no y-stack needed.
    expect(e3!.x).toBe(e1!.x)
  })

  it('stacks same-timestamp beads on one rail with bounded symmetric offsets', () => {
    const layout = deriveEvidenceGraphLayout(graph({ timeline: [group({
      key: 'idea:1',
      claims: [claim({ claimKey: 'claim:c1', history: [
        entry({ sourceEventId: 'a', ts: '2026-09-01T10:00:00.000Z' }),
        entry({ sourceEventId: 'b', ts: '2026-09-01T10:00:00.000Z' }),
      ] })],
    })] }))
    const beads = layout.nodes.filter(node => node.kind === 'event')
    expect(beads).toHaveLength(2)
    expect(beads[0]?.x).toBe(beads[1]?.x)
    expect(beads[0]?.y).not.toBe(beads[1]?.y)
  })

  it('wires a cross-claim inflow and skips it when the source claim is absent', () => {
    const edges = [edge({ id: 'e1', sourceEventId: 'e1', src: 'claim:c2', dst: 'claim:c1' })]
    const layout = deriveEvidenceGraphLayout(graph({
      timeline: [group({ key: 'idea:1', claims: [
        claim({ claimKey: 'claim:c1', history: [entry({ sourceEventId: 'e1', ts: '2026-09-02T10:00:00.000Z' })] }),
        claim({ claimKey: 'claim:c2', history: [entry({ sourceEventId: 'e0', ts: '2026-09-01T10:00:00.000Z' })] }),
      ] })],
      edges,
    }))
    const inflows = layout.links.filter(link => link.kind === 'inflow')
    expect(inflows).toHaveLength(1)
    expect(inflows[0]?.toId).toBe('e1')
    expect(inflows[0]?.d).toMatch(/^M .* C .*$/)

    const missing = deriveEvidenceGraphLayout(graph({
      timeline: [group({ key: 'idea:1', claims: [
        claim({ claimKey: 'claim:c1', history: [entry({ sourceEventId: 'e1', ts: '2026-09-02T10:00:00.000Z' })] }),
      ] })],
      edges: [edge({ id: 'e1', sourceEventId: 'e1', src: 'claim:elsewhere', dst: 'claim:c1' })],
    }))
    expect(missing.links.filter(link => link.kind === 'inflow')).toHaveLength(0)
  })

  it('renders an external-source stub and drop-in for non-claim sources', () => {
    const layout = deriveEvidenceGraphLayout(graph({
      timeline: [group({ key: 'idea:1', claims: [
        claim({ claimKey: 'claim:c1', history: [entry({ sourceEventId: 'e1', ts: '2026-09-02T10:00:00.000Z' })] }),
      ] })],
      edges: [edge({ id: 'e1', sourceEventId: 'e1', src: 'lit:arxiv:2401.00009', dst: 'claim:c1' })],
    }))
    expect(layout.nodes.some(node => node.kind === 'source')).toBe(true)
    expect(layout.links.some(link => link.kind === 'external')).toBe(true)
  })

  it('loops a retraction back onto its retracted declaration bead', () => {
    const edges = [edge({ id: 'e1', sourceEventId: 'e1', dst: 'claim:c1', retracted: true, retractEventId: 'r1' })]
    const layout = deriveEvidenceGraphLayout(graph({
      timeline: [group({ key: 'idea:1', claims: [claim({ claimKey: 'claim:c1', history: [
        entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z', retracted: true }),
        entry({ sourceEventId: 'r1', ts: '2026-09-05T10:00:00.000Z', rel: 'evidence.edge.retracted', retracted: true }),
      ] })] })],
      edges,
    }))
    const retract = layout.links.find(link => link.kind === 'retract')
    expect(retract).toBeDefined()
    expect(retract?.fromId).toBe('r1')
    expect(retract?.toId).toBe('e1')
  })

  it('marks and arcs the active conflict pair', () => {
    const edges = [
      edge({ id: 'sup', sourceEventId: 'sup', rel: 'supports', dst: 'claim:c1' }),
      edge({ id: 'con', sourceEventId: 'con', rel: 'contradicts', dst: 'claim:c1' }),
    ]
    const conflicts: EvidenceConflict[] = [{ nodeKey: 'claim:c1', supporting: edges[0] as EvidenceGraphEdge, contradicting: edges[1] as EvidenceGraphEdge }]
    const layout = deriveEvidenceGraphLayout(graph({
      timeline: [group({ key: 'idea:1', claims: [claim({ claimKey: 'claim:c1', history: [
        entry({ sourceEventId: 'sup', ts: '2026-09-01T10:00:00.000Z', rel: 'supports' }),
        entry({ sourceEventId: 'con', ts: '2026-09-02T10:00:00.000Z', rel: 'contradicts' }),
      ] })] })],
      edges,
      conflicts,
    }))
    const beads = layout.nodes.filter(node => node.kind === 'event')
    expect(beads.every(bead => bead.conflict)).toBe(true)
    expect(layout.links.some(link => link.kind === 'conflict')).toBe(true)
  })

  it('places Eureka markers on the matched band and a fallback band otherwise', () => {
    const timeline = [group({ key: 'idea:1', claims: [
      claim({ claimKey: 'claim:c1', history: [entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' })] }),
    ] })]
    const layout = deriveEvidenceGraphLayout(graph({ timeline }), {
      eurekaDeclarations: [
        { id: 'eu1', at: '2026-09-03T10:00:00.000Z', title: 'A new direction', lineId: '1' },
        { id: 'eu2', at: '2026-09-04T10:00:00.000Z', title: 'Unattributed insight', lineId: null },
      ],
    })
    const markers = layout.nodes.filter(node => node.kind === 'eureka')
    expect(markers).toHaveLength(2)
    expect(markers[0]?.y).toBeLessThan(layout.rails[0]?.y ?? Infinity)
    expect(layout.bands.some(band => band.key === EUREKA_FALLBACK_BAND)).toBe(true)
  })

  it('is deterministic for a given input (deep equal across runs)', () => {
    const timeline = [group({ key: 'idea:1', claims: [claim({ claimKey: 'claim:c1', history: [
      entry({ sourceEventId: 'e1', ts: '2026-09-01T08:00:00.000Z' }),
      entry({ sourceEventId: 'r1', ts: '2026-09-02T08:00:00.000Z', rel: 'evidence.edge.retracted', retracted: true }),
    ] })] })]
    const edges = [edge({ id: 'e1', sourceEventId: 'e1', retractEventId: 'r1', retracted: true })]
    const first = deriveEvidenceGraphLayout(graph({ timeline, edges }))
    const second = deriveEvidenceGraphLayout(graph({ timeline, edges }))
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('returns an empty, finite layout for an empty timeline', () => {
    const layout = deriveEvidenceGraphLayout(graph({ timeline: [] }))
    expect(layout.nodes).toEqual([])
    expect(layout.links).toEqual([])
    expect(layout.bands).toEqual([])
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('fails open on invalid timestamps without throwing or emitting NaN', () => {
    const layout = deriveEvidenceGraphLayout(graph({ timeline: [group({
      key: 'idea:1',
      claims: [claim({ claimKey: 'claim:c1', history: [
        entry({ sourceEventId: 'bad', ts: 'not-a-date' }),
        entry({ sourceEventId: 'good', ts: '2026-09-01T10:00:00.000Z' }),
      ] })],
    })] }))
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true)
      expect(Number.isFinite(node.y)).toBe(true)
    }
    for (const link of layout.links) {
      expect(link.d).toMatch(/^M /)
      expect(link.d.includes('NaN')).toBe(false)
    }
  })

  it('truncates labels CJK-safely', () => {
    expect(clipLabel('short label', 20)).toBe('short label')
    expect(clipLabel('A very long label that exceeds the budget', 20)).toMatch(/…$/)
    expect(clipLabel('中文标签很长需要截断处理', 8)).toMatch(/…$/)
  })
})
