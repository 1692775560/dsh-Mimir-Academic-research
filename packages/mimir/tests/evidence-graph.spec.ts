/**
 * G0 gate for the evidence graph fold: determinism, event-order invariance,
 * dedup idempotence, retraction resolution (last-declaration-wins, re-add,
 * orphans), active-口径 conflict pairing, the timeline's group-key stability
 * (the late-added ideaId case), and the derived edges from existing actions
 * (imports/yields/pinned-as/narrates). Until this file is green, the read
 * path must not hand a non-empty graph to any UI.
 * @module dsh-mimir/tests/evidence-graph
 */

import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_EDGE_ADDED_ACTION,
  EVIDENCE_EDGE_RETRACTED_ACTION,
  deriveEvidenceGraph,
  renderEvidenceGraphMarkdown,
} from '../src/evidence-graph.ts'
import type { EventRecord, LedgerActor, LedgerJsonValue } from '../src/types.ts'
import { dedupKeyOf, titleFingerprint } from '../src/evidence-identity.ts'

const USER: LedgerActor = { kind: 'user', id: 'panel' }
const AGENT: LedgerActor = { kind: 'agent', id: 'wiki_note' }

const WIKI = {
  ideas: [{ id: 'idea-1', title: '扩散引导研究' }],
  claims: [{ id: 'claim-1', text: 'CFG 提升扩散模型的对齐度', status: 'pending' }],
  projects: [{ id: 'proj-1', title: '生成式对齐' }],
}

// Deterministic, content-derived event ids: identical (ts, action, refs,
// payload) always yields the same id, so reversed or re-built streams stay
// byte-comparable while distinct events within one stream never collide.
function stableHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function ev(
  ts: string,
  action: string,
  refs: Partial<EventRecord['refs']> = {},
  payload: Record<string, LedgerJsonValue> = {},
  actor: LedgerActor = USER,
): EventRecord {
  const id = `ev-${stableHash(JSON.stringify([ts, action, refs, payload]))}`
  return Object.freeze({
    id,
    ts,
    actor,
    action,
    refs: Object.freeze(refs),
    payload: Object.freeze(payload),
  })
}

const BASE = Date.parse('2026-09-01T09:00:00.000Z')
const MIN = 60_000
const at = (offsetMinutes: number): string => new Date(BASE + offsetMinutes * MIN).toISOString()

const KEY_A = dedupKeyOf('supports', 'lit:arxiv:2401.00001', 'claim:claim-1', 'proj-1/')
const KEY_B = dedupKeyOf('contradicts', 'lit:arxiv:2401.00002', 'claim:claim-1', 'proj-1/')

function added(
  offset: number,
  dedupKey: string,
  rel: string,
  src: string,
  dst: string,
  refs: Partial<EventRecord['refs']> = { projectId: 'proj-1', claimId: 'claim-1' },
  note = '来自摘要的判断',
  actor: LedgerActor = USER,
): EventRecord {
  return ev(at(offset), EVIDENCE_EDGE_ADDED_ACTION, refs, {
    rel, src, dst, note, dedupKey,
  }, actor)
}

function retracted(offset: number, dedupKey: string, refs: Partial<EventRecord['refs']> = {}, reason = '误判', actor: LedgerActor = USER): EventRecord {
  return ev(at(offset), EVIDENCE_EDGE_RETRACTED_ACTION, refs, { dedupKey, reason }, actor)
}

describe('determinism and order invariance', () => {
  const stream = (): EventRecord[] => [
    added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
    ev(at(5), 'literature.paper.imported', { paperId: '2401.00001', projectId: 'proj-1' }, { title: 'Deep Learning: A Survey' }),
    added(10, KEY_B, 'contradicts', 'lit:arxiv:2401.00002', 'claim:claim-1'),
    retracted(15, KEY_B, { projectId: 'proj-1', claimId: 'claim-1' }),
    ev(at(20), 'journal.entry.added', { projectId: 'proj-1' }, { text: '今天读了两篇' }),
  ]

  it('is deterministic: the same input folds to the same graph', () => {
    const left = deriveEvidenceGraph(stream(), WIKI)
    const right = deriveEvidenceGraph(stream(), WIKI)
    expect(left).toEqual(right)
  })

  it('is invariant to event order (a shuffled stream folds identically)', () => {
    const ordered = deriveEvidenceGraph(stream(), WIKI)
    const shuffled = deriveEvidenceGraph([...stream()].reverse(), WIKI)
    expect(shuffled).toEqual(ordered)
  })
})

describe('dedup merge', () => {
  it('merges duplicate declarations and keeps the earliest event id', () => {
    const first = added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1')
    const second = added(30, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1', { projectId: 'proj-1', claimId: 'claim-1' }, '重复声明')
    const graph = deriveEvidenceGraph([first, second], WIKI)
    const edges = graph.edges.filter(edge => edge.rel === 'supports')
    expect(edges).toHaveLength(1)
    expect(edges[0]?.id).toBe(first.id) // the earliest declaration's event wins
    expect(graph.stats.duplicateEdges).toBe(1)
    expect(graph.stats.totalEdges).toBe(1)
  })

  it('keeps distinct declarations apart when the dedupKey differs', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      added(5, KEY_B, 'contradicts', 'lit:arxiv:2401.00002', 'claim:claim-1'),
    ], WIKI)
    expect(graph.stats.totalEdges).toBe(2)
    expect(graph.stats.duplicateEdges).toBe(0)
  })
})

describe('retraction resolution (last-declaration-wins)', () => {
  it('marks the edge retracted and keeps it in the fold', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(10, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
    ], WIKI)
    const edge = graph.edges.find(edge => edge.rel === 'supports')
    expect(edge?.retracted).toBe(true)
    expect(edge?.retractedAt).toBe(at(10))
    expect(edge?.retractedBy).toEqual(USER)
    expect(edge?.retractReason).toBe('误判')
    expect(graph.stats.retractedEdges).toBe(1)
    expect(graph.stats.activeEdges).toBe(0)
  })

  it('collapses duplicate retractions into one state flip (idempotence)', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(10, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
      retracted(20, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }, '再次撤回'),
    ], WIKI)
    const edge = graph.edges.find(edge => edge.rel === 'supports')
    expect(edge?.retracted).toBe(true)
    // The LAST retraction carries the retractedAt/reason (one flip, latest words).
    expect(edge?.retractedAt).toBe(at(20))
    expect(graph.stats.retractedEdges).toBe(1)
  })

  it('lets a re-assertion bring the edge back to active', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(10, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
      added(20, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
    ], WIKI)
    const edge = graph.edges.find(edge => edge.rel === 'supports')
    expect(edge?.retracted).toBe(false)
    expect(graph.stats.activeEdges).toBe(1)
    expect(graph.stats.retractedEdges).toBe(0)
  })

  it('counts orphan retractions instead of dropping them silently', () => {
    const graph = deriveEvidenceGraph([
      retracted(0, 'f'.repeat(32), { projectId: 'proj-1', claimId: 'claim-1' }),
    ], WIKI)
    expect(graph.stats.retractOrphans).toBe(1)
    expect(graph.stats.totalEdges).toBe(0)
  })

  it('resolves interleaved added/retracted streams by last declaration', () => {
    const ordered = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(10, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
      added(20, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(30, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
    ], WIKI)
    const shuffled = deriveEvidenceGraph([
      retracted(30, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
      added(20, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(10, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
    ], WIKI)
    expect(shuffled).toEqual(ordered)
    expect(ordered.edges.find(edge => edge.rel === 'supports')?.retracted).toBe(true)
  })
})

describe('conflict pairing (active口径 only)', () => {
  it('pairs an active support with an active contradiction', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      added(5, KEY_B, 'contradicts', 'lit:arxiv:2401.00002', 'claim:claim-1'),
    ], WIKI)
    expect(graph.conflicts).toHaveLength(1)
    expect(graph.conflicts[0]?.nodeKey).toBe('claim:claim-1')
    expect(graph.conflicts[0]?.supporting.sourceEventId).not.toBe(graph.conflicts[0]?.contradicting.sourceEventId)
  })

  it('never pairs when the support has been retracted', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(5, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
      added(10, KEY_B, 'contradicts', 'lit:arxiv:2401.00002', 'claim:claim-1'),
    ], WIKI)
    expect(graph.conflicts).toHaveLength(0)
  })
})

describe('alias union-find', () => {
  it('merges two node keys sharing a title fingerprint and discloses the merge', () => {
    const keys1 = dedupKeyOf('cites', 'lit:arxiv:2401.00001', 'lit:arxiv:2401.00002', '//')
    const keys2 = dedupKeyOf('cites', 'lit:title:' + 'a'.repeat(16), 'lit:arxiv:2401.00002', '//')
    const graph = deriveEvidenceGraph([
      ev(at(0), EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:2401.00001', dst: 'lit:arxiv:2401.00002', dedupKey: keys1,
        keys: { titleFp: 'a'.repeat(16) },
      }),
      ev(at(5), EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:title:' + 'a'.repeat(16), dst: 'lit:arxiv:2401.00002', dedupKey: keys2,
      }),
    ], WIKI)
    expect(graph.stats.aliasMerges).toBeGreaterThanOrEqual(1)
    // Both edges now land on the same canonical dst node.
    const cites = graph.edges.filter(edge => edge.rel === 'cites')
    expect(cites[0]?.dst).toBe(cites[1]?.dst)
  })

  it('unifies imported-paper titles into a fingerprint alias in-fold', () => {
    const graph = deriveEvidenceGraph([
      ev(at(0), 'literature.paper.imported', { paperId: '2401.00001' }, { title: 'Deep Learning: A Survey' }),
      ev(at(5), 'literature.paper.imported', { paperId: '2401.00001v2' }, { title: 'deep learning a survey' }),
      // A node only materializes from an edge endpoint (nodes = edge endpoints,
      // unified through the alias map), so anchor the paper with a cites edge.
      ev(at(10), EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:2401.00001', dst: 'lit:doi:10.0000/survey', dedupKey: dedupKeyOf('cites', 'lit:arxiv:2401.00001', 'lit:doi:10.0000/survey', '//'),
      }),
    ], WIKI)
    expect(graph.stats.aliasMerges).toBeGreaterThanOrEqual(1)
    const arxivNode = graph.nodes.find(node => node.key === 'lit:arxiv:2401.00001')
    expect(arxivNode?.aliases).toContain('lit:title:' + titleFingerprintOf('deep learning a survey'))
  })
})

// Local helper: import the pipeline itself to avoid a second copy of the truth.
function titleFingerprintOf(title: string): string {
  return titleFingerprint(title) ?? ''
}

describe('derived edges from existing actions', () => {
  it('derives imports/yields/pinned-as/narrates without new emission points', () => {
    const graph = deriveEvidenceGraph([
      ev(at(0), 'literature.paper.imported', { paperId: '2401.00001', projectId: 'proj-1' }, { title: 'A Survey' }),
      ev(at(5), 'compute.job.settled', { jobId: 'job-1', experimentId: 'exp-1' }, { status: 'succeeded' }),
      ev(at(10), 'cbe.moment.pin', { ideaId: 'idea-1' }, { targetEventId: 'ev-0001', note: '转折点' }),
      ev(at(15), 'journal.entry.added', { ideaId: 'idea-1' }, { text: '今天写了一页' }),
    ], WIKI)
    const rels = graph.edges.map(edge => edge.rel)
    expect(rels).toContain('imports')
    expect(rels).toContain('yields')
    expect(rels).toContain('pinned-as')
    expect(rels).toContain('narrates')
    // narrates stays out of the evidence stats (the L2 constitution).
    expect(graph.stats.totalEdges).toBe(3)
    const imports = graph.edges.find(edge => edge.rel === 'imports')
    expect(imports?.src).toBe('proj:proj-1')
    expect(imports?.dst).toBe('lit:arxiv:2401.00001')
    const pin = graph.edges.find(edge => edge.rel === 'pinned-as')
    expect(pin?.dst).toBe('moment:ev-0001')
    // The journal actor line rides the event's own line attribution.
    const narrates = graph.edges.find(edge => edge.rel === 'narrates')
    expect(narrates?.dst).toBe('idea:idea-1')
  })
})

describe('timeline projection (v1.1 §2.4)', () => {
  it('keeps one claim in ONE group when the ideaId arrives late', () => {
    const graph = deriveEvidenceGraph([
      // First declaration attributes only to the project.
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1', { projectId: 'proj-1', claimId: 'claim-1' }),
      // Later declaration carries the ideaId (the 后补 scenario).
      added(10, KEY_B, 'contradicts', 'lit:arxiv:2401.00002', 'claim:claim-1', { projectId: 'proj-1', ideaId: 'idea-1', claimId: 'claim-1' }),
    ], WIKI)
    expect(graph.timeline).toHaveLength(1)
    const group = graph.timeline[0]
    expect(group?.kind).toBe('idea')
    expect(group?.key).toBe('idea:idea-1')
    expect(group?.label).toBe('扩散引导研究')
    expect(group?.claims).toHaveLength(1)
    const claim = group?.claims[0]
    expect(claim?.claimKey).toBe('claim:claim-1')
    expect(claim?.supportsCount).toBe(1)
    expect(claim?.contradictsCount).toBe(1)
    // History is ts-ascending and shows the full accumulation.
    expect(claim?.history.map(entry => entry.rel)).toEqual(['supports', 'contradicts'])
  })

  it('keeps retracted rows inline with the strikethrough mark', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      retracted(10, KEY_A, { projectId: 'proj-1', claimId: 'claim-1' }),
      added(20, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
    ], WIKI)
    const claim = graph.timeline[0]?.claims[0]
    expect(claim?.history).toHaveLength(3) // superseded added → retract row → re-added
    expect(claim?.history.filter(entry => entry.retracted)).toHaveLength(2)
    // The claim stays counted in the active口径.
    expect(claim?.supportsCount).toBe(1)
  })

  it('leaves claim-less edges out of the timeline (flat list only)', () => {
    const keys = dedupKeyOf('cites', 'lit:arxiv:1', 'lit:arxiv:2', '//')
    const graph = deriveEvidenceGraph([
      ev(at(0), EVIDENCE_EDGE_ADDED_ACTION, {}, {
        rel: 'cites', src: 'lit:arxiv:1', dst: 'lit:arxiv:2', dedupKey: keys,
      }),
    ], WIKI)
    expect(graph.timeline).toHaveLength(0)
    expect(graph.stats.totalEdges).toBe(1)
  })

  it('resolves the claim label and status from the wiki and the ledger', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      ev(at(5), 'knowledge.claim.set', { claimId: 'claim-1' }, { status: 'supported' }),
    ], WIKI)
    const claim = graph.timeline[0]?.claims[0]
    expect(claim?.claimLabel).toContain('CFG 提升扩散模型')
    expect(claim?.status).toBe('supported')
  })
})

describe('markdown export', () => {
  it('renders the grouped history, conflicts, and retraction sections', () => {
    const graph = deriveEvidenceGraph([
      added(0, KEY_A, 'supports', 'lit:arxiv:2401.00001', 'claim:claim-1'),
      added(5, KEY_B, 'contradicts', 'lit:arxiv:2401.00002', 'claim:claim-1'),
      retracted(10, KEY_B, { projectId: 'proj-1', claimId: 'claim-1' }),
    ], WIKI)
    const markdown = renderEvidenceGraphMarkdown(graph)
    expect(markdown).toContain('# Evidence Graph')
    expect(markdown).toContain('## Evidence history by research line')
    expect(markdown).toContain('## Conflicts')
    expect(markdown).toContain('## Retracted edges')
    expect(markdown).toContain(KEY_B)
    expect(markdown).toContain('误判')
  })
})
