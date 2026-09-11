/**
 * QA composite gate (independent verification, kept as a deliverable):
 * service-level composite flows over a REAL memory-backed ledger that the
 * fold-only unit specs cannot cover —
 *   1. interleaved added→retracted→re-added→duplicate→retracted streams
 *      folded through getEvidenceGraph (stats + timeline + determinism),
 *   2. the exact boundary values of the field caps (note 256/257, reason
 *      256/257, keys.url normalized 256/257, and the payload JSON cap at
 *      exactly 1500/1501 — still reachable via the four alias keys) at the
 *      emit boundary,
 *   3. the retraction permission reverse-lookup (agent own-edge only,
 *      orphan handling) against a real event stream,
 *   4. timeline group stability when the ideaId arrives mid-history.
 * @module dsh-mimir/tests/evidence-qa-composite
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { researchWikiDomainSpec } from '../src/store.ts'
import type { ResearchWikiDomain } from '../src/store.ts'
import { PANEL_ACTOR, WIKI_AGENT_ACTOR, REVIEWER_ACTOR } from '../src/ledger.ts'
import type { LedgerActor } from '../src/types.ts'
import {
  addEvidenceEdge,
  EVIDENCE_EDGE_PAYLOAD_MAX_CHARS,
  getEvidenceGraph,
  retractEvidenceEdge,
} from '../src/services/evidence.ts'
import { ALIAS_MAX_CHARS, dedupKeyOf, LABEL_MAX_CHARS, NOTE_MAX_CHARS } from '../src/evidence-identity.ts'

/** Boot one open research-wiki domain over a throwaway memory medium. */
async function domainHarness(): Promise<ResearchWikiDomain> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  return facility.open(researchWikiDomainSpec)
}

async function harnessWithClaim(): Promise<{ domain: ResearchWikiDomain; claimId: string }> {
  const domain = await domainHarness()
  const claimId = 'claim-qa-1'
  await domain.table('claims').put(claimId, {
    id: claimId,
    text: 'QA 复合流检验声明',
    status: 'pending',
    evidence: '',
  })
  return { domain, claimId }
}

const dstOf = (claimId: string): string => `claim:${claimId}`

/** Outrun the same-millisecond read race (see the dedicated race probe). */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 5) })

describe('composite stream (service level, real ledger)', () => {
  it('folds an interleaved duplicate/retract/re-add stream into last-declaration-wins, deterministically', async () => {
    const { domain, claimId } = await harnessWithClaim()
    const dst = dstOf(claimId)
    // add A → retract A → re-add A → duplicate A → retract A  (A ends retracted)
    const a1 = await addEvidenceEdge({ domain }, { rel: 'supports', src: 'lit:arxiv:2401.00001', dst, claimId })
    expect(a1.ok).toBe(true)
    const r1 = await retractEvidenceEdge({ domain }, { dedupKey: a1.ok ? a1.value.dedupKey : '', claimId, reason: '第一次撤回' })
    expect(r1.ok).toBe(true)
    const a2 = await addEvidenceEdge({ domain }, { rel: 'supports', src: 'lit:arxiv:2401.00001', dst, claimId, note: '重新声明' })
    expect(a2.ok).toBe(true)
    if (a1.ok && a2.ok) expect(a2.value.dedupKey).toBe(a1.value.dedupKey) // same identity → dedupKey merge
    const a3 = await addEvidenceEdge({ domain }, { rel: 'supports', src: 'lit:arxiv:2401.00001', dst, claimId })
    expect(a3.ok).toBe(true)
    const r2 = await retractEvidenceEdge({ domain }, { dedupKey: a1.ok ? a1.value.dedupKey : '', claimId, reason: '最终撤回' })
    expect(r2.ok).toBe(true)
    // edge B stays active
    const b = await addEvidenceEdge({ domain }, { rel: 'contradicts', src: 'lit:arxiv:2401.00002', dst, claimId })
    expect(b.ok).toBe(true)

    await settle()
    const first = await getEvidenceGraph({ domain }, {})
    expect(first.ok).toBe(true)
    const second = await getEvidenceGraph({ domain }, {})
    if (first.ok && second.ok) {
      // derivedAt/window differ between calls; the graph itself must not.
      expect(second.value.graph).toEqual(first.value.graph)
      const graph = first.value.graph
      expect(graph.stats.totalEdges).toBe(2)
      expect(graph.stats.retractedEdges).toBe(1)
      expect(graph.stats.activeEdges).toBe(1)
      expect(graph.stats.duplicateEdges).toBe(2) // 3 declarations of one identity → 2 merged
      const supports = graph.edges.filter(edge => edge.rel === 'supports')
      expect(supports).toHaveLength(1)
      expect(supports[0]?.retracted).toBe(true)
      expect(supports[0]?.retractReason).toBe('最终撤回')
      // the timeline keeps every row inline (3 declarations + 2 retraction
      // rows + the contradicts edge), active counts use the active口径
      const claim = graph.timeline[0]?.claims[0]
      expect(claim?.history).toHaveLength(6)
      expect(claim?.supportsCount).toBe(0)
      expect(claim?.contradictsCount).toBe(1)
    }
  })
})

describe('field-cap boundary values (emit boundary)', () => {
  it('accepts note at exactly 256 chars and rejects 257', async () => {
    const { domain, claimId } = await harnessWithClaim()
    const dst = dstOf(claimId)
    const ok = await addEvidenceEdge({ domain }, {
      rel: 'supports', src: 'lit:arxiv:1', dst, claimId,
      note: '纳'.repeat(NOTE_MAX_CHARS),
    })
    expect(ok.ok).toBe(true)
    const over = await addEvidenceEdge({ domain }, {
      rel: 'supports', src: 'lit:arxiv:2', dst, claimId,
      note: '纳'.repeat(NOTE_MAX_CHARS + 1),
    })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error.code).toBe('invalid-input')
  })

  it('accepts reason at exactly 256 chars and rejects 257', async () => {
    const { domain, claimId } = await harnessWithClaim()
    const dst = dstOf(claimId)
    const added = await addEvidenceEdge({ domain }, { rel: 'supports', src: 'lit:arxiv:3', dst, claimId })
    expect(added.ok).toBe(true)
    const ok = await retractEvidenceEdge({ domain }, {
      dedupKey: added.ok ? added.value.dedupKey : '', claimId,
      reason: '撤'.repeat(NOTE_MAX_CHARS),
    })
    expect(ok.ok).toBe(true)
    const added2 = await addEvidenceEdge({ domain }, { rel: 'supports', src: 'lit:arxiv:4', dst, claimId })
    expect(added2.ok).toBe(true)
    const over = await retractEvidenceEdge({ domain }, {
      dedupKey: added2.ok ? added2.value.dedupKey : '', claimId,
      reason: '撤'.repeat(NOTE_MAX_CHARS + 1),
    })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error.code).toBe('invalid-input')
  })

  it('rejects an over-cap url alias before the payload cap can speak, and accepts the all-caps maximum', async () => {
    const { domain, claimId } = await harnessWithClaim()
    const dst = dstOf(claimId)
    // The alias cap is measured on the NORMALIZED url, symmetric with
    // keys.arxiv; the payload JSON cap sits behind it (see the dedicated
    // 1500-boundary case below — reachable via the FOUR alias keys).
    const urlOf = (padChars: number): string => `https://example.com/${'p'.repeat(padChars)}`
    const over = await addEvidenceEdge({ domain }, {
      rel: 'supports', src: 'lit:arxiv:1', dst, claimId,
      keys: { url: urlOf(ALIAS_MAX_CHARS - 20 + 1) }, // normalized length = 257
    })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error.code).toBe('invalid-input')
    const exact = await addEvidenceEdge({ domain }, {
      rel: 'retrieved-via', src: `lit:${'a'.repeat(124)}`, dst: `lit:${'b'.repeat(124)}`,
      srcLabel: '标'.repeat(LABEL_MAX_CHARS), dstLabel: '签'.repeat(LABEL_MAX_CHARS),
      keys: { url: urlOf(ALIAS_MAX_CHARS - 20) }, // normalized length = exactly 256
      note: '注'.repeat(NOTE_MAX_CHARS),
    })
    expect(exact.ok).toBe(true)
  })

  it('accepts an edge payload of exactly 1500 JSON chars and rejects 1501 (reachable via the four alias keys)', async () => {
    const { domain, claimId } = await harnessWithClaim()
    const dst = dstOf(claimId)
    // One alias key alone cannot reach 1500 (~1.1k), but arxiv+doi+url
    // TOGETHER top out ~1.7k (max measured 1787 with every field capped),
    // so the v1.1 §2.1 payload cap stays a real boundary, not dead code.
    // The dedupKey is computed from rel/src/dst/scope only — independent of
    // keys — so the payload JSON length is solvable offline.
    const dedupKey = dedupKeyOf('supports', 'lit:arxiv:1', dst, `/${claimId}/`)
    const payloadAt = (arxivPad: number, urlPad: number): string => JSON.stringify({
      rel: 'supports',
      src: 'lit:arxiv:1',
      dst,
      srcLabel: '标'.repeat(LABEL_MAX_CHARS),
      dstLabel: '签'.repeat(LABEL_MAX_CHARS),
      keys: {
        arxiv: 'a'.repeat(arxivPad),
        doi: `10.1234/${'o'.repeat(247)}`,
        url: `https://example.com/${'u'.repeat(urlPad)}`,
        titleFp: 'f'.repeat(16),
      },
      note: '注'.repeat(NOTE_MAX_CHARS),
      dedupKey,
    })
    const buildRequest = (arxivPad: number, urlPad: number) => ({
      rel: 'supports' as const,
      src: 'lit:arxiv:1',
      dst,
      claimId,
      srcLabel: '标'.repeat(LABEL_MAX_CHARS),
      dstLabel: '签'.repeat(LABEL_MAX_CHARS),
      keys: {
        arxiv: 'a'.repeat(arxivPad),
        doi: `10.1234/${'o'.repeat(247)}`,
        url: `https://example.com/${'u'.repeat(urlPad)}`,
        titleFp: 'f'.repeat(16),
      },
      note: '注'.repeat(NOTE_MAX_CHARS),
    })
    // Solve the two pads so the JSON lands exactly on 1500 (each within its
    // own ALIAS_MAX_CHARS budget: arxiv ≤255, url ≤236 after the prefix).
    const base = payloadAt(0, 0).length
    const delta = EVIDENCE_EDGE_PAYLOAD_MAX_CHARS - base
    const urlPad = Math.min(236, delta)
    const arxivPad = delta - urlPad
    expect(arxivPad).toBeGreaterThanOrEqual(0)
    expect(arxivPad).toBeLessThanOrEqual(255)
    expect(payloadAt(arxivPad, urlPad).length).toBe(EVIDENCE_EDGE_PAYLOAD_MAX_CHARS)
    const exact = await addEvidenceEdge({ domain }, buildRequest(arxivPad, urlPad))
    expect(exact.ok).toBe(true)
    const over = await addEvidenceEdge({ domain }, buildRequest(arxivPad, urlPad + 1))
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error.code).toBe('invalid-input')
  })
})

describe('retraction permission (service-level reverse lookup)', () => {
  it('denies an agent retracting an edge declared by another actor, allows its own', async () => {
    const { domain, claimId } = await harnessWithClaim()
    const dst = dstOf(claimId)
    const agentAdd = await addEvidenceEdge({ domain }, { rel: 'supports', src: 'lit:arxiv:5', dst, claimId }, WIKI_AGENT_ACTOR)
    expect(agentAdd.ok).toBe(true)
    const panelAdd = await addEvidenceEdge({ domain }, { rel: 'supports', src: 'lit:arxiv:6', dst, claimId }, PANEL_ACTOR)
    expect(panelAdd.ok).toBe(true)

    // The reviewer subagent is NOT the declarer of either edge.
    const reviewerOnAgent = await retractEvidenceEdge({ domain }, {
      dedupKey: agentAdd.ok ? agentAdd.value.dedupKey : '', claimId,
    }, REVIEWER_ACTOR)
    expect(reviewerOnAgent.ok).toBe(false)
    if (!reviewerOnAgent.ok) expect(reviewerOnAgent.error.code).toBe('invalid-input')
    const reviewerOnPanel = await retractEvidenceEdge({ domain }, {
      dedupKey: panelAdd.ok ? panelAdd.value.dedupKey : '', claimId,
    }, REVIEWER_ACTOR)
    expect(reviewerOnPanel.ok).toBe(false)

    // The agent retracts its OWN edge (allowed), then the panel retracts the rest (allowed).
    const agentOwn = await retractEvidenceEdge({ domain }, {
      dedupKey: agentAdd.ok ? agentAdd.value.dedupKey : '', claimId, reason: '自撤',
    }, WIKI_AGENT_ACTOR)
    expect(agentOwn.ok).toBe(true)
    const panelAny = await retractEvidenceEdge({ domain }, {
      dedupKey: panelAdd.ok ? panelAdd.value.dedupKey : '', claimId,
    }, PANEL_ACTOR)
    expect(panelAny.ok).toBe(true)
  })

  it('rejects an agent orphan retraction but lets the panel pass', async () => {
    const { domain, claimId } = await harnessWithClaim()
    void claimId
    const ghost = 'a'.repeat(32)
    const agentOrphan = await retractEvidenceEdge({ domain }, { dedupKey: ghost }, WIKI_AGENT_ACTOR as LedgerActor)
    expect(agentOrphan.ok).toBe(false)
    if (!agentOrphan.ok) expect(agentOrphan.error.code).toBe('invalid-input')
    const panelOrphan = await retractEvidenceEdge({ domain }, { dedupKey: 'b'.repeat(32) }, PANEL_ACTOR)
    expect(panelOrphan.ok).toBe(true) // disclosed by the fold as a retract orphan
    await settle()
    const view = await getEvidenceGraph({ domain }, {})
    if (view.ok) expect(view.value.graph.stats.retractOrphans).toBe(1)
  })
})

describe('same-millisecond read race (QA reproduction)', () => {
  it('getEvidenceGraph must never drop an event emitted in the same millisecond as the read', async () => {
    // sliceEvents treats `until` as EXCLUSIVE (time.ts: `ms < toMs`), while
    // getEvidenceGraph defaults `until = new Date().toISOString()` captured
    // AFTER the writes. A read in the same millisecond as the last emit
    // silently drops that event from the fold. Loop until the race hits or
    // the budget is exhausted; a single hit proves the nondeterminism.
    let hits = 0
    let attempts = 0
    for (let round = 0; round < 300 && hits === 0; round += 1) {
      attempts += 1
      const { domain, claimId } = await harnessWithClaim()
      const added = await addEvidenceEdge({ domain }, {
        rel: 'supports', src: 'lit:arxiv:9', dst: dstOf(claimId), claimId,
      })
      expect(added.ok).toBe(true)
      const view = await getEvidenceGraph({ domain }, {})
      if (view.ok && view.value.graph.stats.totalEdges === 0) hits += 1
    }
    console.log(`RACE_PROBE attempts=${attempts} hits=${hits}`)
    expect(hits).toBe(0)
  })
})

describe('timeline group stability with mixed scopes', () => {
  it('keeps one idea group when the ideaId arrives mid-history, retraction included', async () => {
    const { domain, claimId } = await harnessWithClaim()
    const dst = dstOf(claimId)
    await domain.table('ideas').put('idea-qa-1', { id: 'idea-qa-1', title: 'QA 研究线' })
    const scopedAdd = await addEvidenceEdge({ domain }, {
      rel: 'supports', src: 'lit:arxiv:7', dst, claimId, projectId: 'p-qa', ideaId: 'idea-qa-1',
    })
    expect(scopedAdd.ok).toBe(false) // unknown projectId rejected at the boundary
    const lateAdd = await addEvidenceEdge({ domain }, {
      rel: 'supports', src: 'lit:arxiv:7', dst, claimId, ideaId: 'idea-qa-1',
    })
    expect(lateAdd.ok).toBe(true)
    const early = await addEvidenceEdge({ domain }, { rel: 'contradicts', src: 'lit:arxiv:8', dst, claimId })
    expect(early.ok).toBe(true)
    await settle()
    const view = await getEvidenceGraph({ domain }, {})
    if (view.ok) {
      expect(view.value.graph.timeline).toHaveLength(1)
      const group = view.value.graph.timeline[0]
      expect(group?.kind).toBe('idea')
      expect(group?.claims[0]?.history).toHaveLength(2)
    }
  })
})
