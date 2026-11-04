/**
 * Render tests for the evidence graph canvas (PRD §69/§70): the claim-head
 * conflict roll-up — dashed ring + chip + accessible name + conflict-pair
 * tooltip lines — against the real `deriveEvidenceGraphLayout` output. The
 * bead-level solid conflict ring must stay distinct. Server-rendered via
 * renderToString, the same harness as the ledger render smoke.
 * @module dsh-client-ui-mimir/tests/evidence-canvas
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type {
  EvidenceClaimHistory,
  EvidenceConflict,
  EvidenceGraphEdge,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'
import { deriveEvidenceGraphLayout, type EvidenceGraphLayoutInput } from '../src/client/evidence-graph-layout.ts'
import { conflictLinesByClaim } from '../src/client/evidence-graph-view.ts'
import { EvidenceGraphCanvas } from '../src/client/EvidenceGraphCanvas.tsx'
import { zh } from '../src/client/locales.ts'
import type { ResearchKey } from '../src/client/locales.ts'
import type { ResearchT } from '../src/client/view-common.ts'

function t(key: ResearchKey, params?: Record<string, string>): string {
  let text: string = zh[key]
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value)
  }
  return text
}

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

/** The two-claim fixture: one conflicted claim, one clean claim. */
const CONFLICT_EDGES = [
  edge({ id: 'sup', sourceEventId: 'sup', rel: 'supports', src: 'lit:arxiv:2401.00001', dst: 'claim:c1', note: 'clean replication' }),
  edge({ id: 'con', sourceEventId: 'con', rel: 'contradicts', src: 'exp:run:0042', dst: 'claim:c1' }),
]
const CONFLICTS: EvidenceConflict[] = [{
  nodeKey: 'claim:c1',
  supporting: CONFLICT_EDGES[0] as EvidenceGraphEdge,
  contradicting: CONFLICT_EDGES[1] as EvidenceGraphEdge,
}]
const FIXTURE = graph({
  timeline: [group({ key: 'idea:1', claims: [
    claim({ claimKey: 'claim:c1', hasConflict: true, history: [
      entry({ sourceEventId: 'sup', ts: '2026-09-01T10:00:00.000Z', rel: 'supports' }),
      entry({ sourceEventId: 'con', ts: '2026-09-02T10:00:00.000Z', rel: 'contradicts' }),
    ] }),
    claim({ claimKey: 'claim:c2', hasConflict: false, history: [
      entry({ sourceEventId: 'ok', ts: '2026-09-03T10:00:00.000Z', rel: 'supports' }),
    ] }),
  ] })],
  edges: CONFLICT_EDGES,
  conflicts: CONFLICTS,
})

function renderCanvas(fix: EvidenceGraphLayoutInput = FIXTURE): string {
  const layout = deriveEvidenceGraphLayout(fix)
  const lines = conflictLinesByClaim(fix.conflicts, t as ResearchT)
  return renderToString(
    <EvidenceGraphCanvas
      layout={layout}
      selectedId={null}
      onSelect={() => {}}
      t={t as ResearchT}
      conflictLinesByClaim={lines}
    />,
  )
}

describe('EvidenceGraphCanvas claim-head conflict roll-up', () => {
  it('renders the dashed conflict ring and the chip on a conflicted claim head', () => {
    const html = renderCanvas()
    expect(html).toContain('evidenceClaimConflictRing')
    expect(html).toContain('evidenceConflictChip')
    expect(html).toContain(t('evidence.conflict'))
  })

  it('renders neither ring nor chip on a conflict-free claim head', () => {
    const clean = graph({ timeline: [group({ key: 'idea:1', claims: [
      claim({ claimKey: 'claim:calm', hasConflict: false, history: [
        entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' }),
      ] }),
    ] })] })
    const html = renderCanvas(clean)
    expect(html).not.toContain('evidenceClaimConflictRing')
    expect(html).not.toContain('evidenceConflictChip')
  })

  it('keeps the bead-level solid conflict ring distinct from the claim ring', () => {
    const html = renderCanvas()
    // Both rings render on the conflicted fixture, under different classes.
    expect(html).toContain('evidenceConflictRing')
    expect(html).toContain('evidenceClaimConflictRing')
    expect(html.match(/evidenceClaimConflictRing/g)?.length ?? 0).toBe(1)
    // The two conflicted beads each carry the solid ring class.
    expect(html.match(/class="[^"]*evidenceConflictRing[^"]*"/g)?.length ?? 0).toBe(2)
  })

  it('speaks the conflict in the accessible label of the claim head', () => {
    const html = renderCanvas()
    expect(html).toContain(`claim:c1 · ${t('evidence.conflict')}`)
    // The clean claim's label carries no conflict suffix.
    expect(html).not.toContain(`claim:c2 · ${t('evidence.conflict')}`)
  })

  it('itemizes both ends of every conflict pair in the claim head title', () => {
    const html = renderCanvas()
    const line = conflictLinesByClaim(CONFLICTS, t as ResearchT).get('claim:c1')?.[0] ?? ''
    expect(line).toBe(`${t('evidence.rel.supports')} · lit:arxiv:2401.00001 ↔ ${t('evidence.rel.contradicts')} · exp:run:0042 · clean replication`)
    expect(html).toContain(`claim:c1 · ${t('evidence.conflict')}\n${line}`)
  })

  it('keeps the ≥28px transparent hit target on every node', () => {
    const html = renderCanvas()
    expect(html.match(/class="[^"]*evidenceNodeHit[^"]*"/g)?.length ?? 0).toBeGreaterThan(0)
    expect(html).toMatch(/evidenceNodeHit[^>]*r="14"/)
  })

  it('roves a single tab stop across the nodes (roving tabindex §51/§102)', () => {
    const html = renderCanvas()
    // Exactly one node is in the Tab order; every other node is skipped.
    expect(html.match(/tabindex="0"/g)?.length ?? 0).toBe(1)
    expect(html.match(/tabindex="-1"/g)?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('EvidenceGraphCanvas link interaction layer (§99)', () => {
  it('gives every link a fat transparent hit path behind its visible stroke', () => {
    const html = renderCanvas()
    // The fixture yields three links: two external inflows (lit + exp
    // sources) and one conflict arc — each one hit path, one visible path.
    expect(html.match(/class="[^"]*evidenceLinkHit[^"]*"/g)?.length ?? 0).toBe(3)
    expect(html.match(/data-kind="external"/g)?.length ?? 0).toBe(2)
    expect(html.match(/data-kind="conflict"/g)?.length ?? 0).toBe(1)
  })

  it('titles each link with its localized kind', () => {
    const html = renderCanvas()
    expect(html).toContain(t('evidence.graph.link.external'))
    expect(html).toContain(t('evidence.graph.link.conflict'))
  })
})

describe('EvidenceGraphCanvas unattributed Eureka band', () => {
  it('labels the fallback band through the locale, never the raw key', () => {
    const layout = deriveEvidenceGraphLayout(FIXTURE, {
      eurekaDeclarations: [{ id: 'eu1', at: '2026-09-04T10:00:00.000Z', title: 'A stray insight', lineId: null }],
    })
    const html = renderToString(
      <EvidenceGraphCanvas
        layout={layout}
        selectedId={null}
        onSelect={() => {}}
        t={t as ResearchT}
      />,
    )
    expect(html).toContain(t('evidence.graph.unattributed'))
    expect(html).not.toContain('eureka:unattributed')
  })
})

describe('EvidenceGraphCanvas focus mode (§47)', () => {
  const TWO_BANDS = graph({
    timeline: [
      group({ key: 'idea:1', claims: [claim({ claimKey: 'claim:c1', history: [entry({ sourceEventId: 'e1', ts: '2026-09-01T10:00:00.000Z' })] })] }),
      group({ key: 'idea:2', claims: [claim({ claimKey: 'claim:c2', history: [entry({ sourceEventId: 'e2', ts: '2026-09-02T10:00:00.000Z' })] })] }),
    ],
  })

  it('dims everything outside the focused band and never dims without focus', () => {
    const layout = deriveEvidenceGraphLayout(TWO_BANDS)
    const focused = renderToString(
      <EvidenceGraphCanvas layout={layout} selectedId={null} focusedBandKey="idea:1" onSelect={() => {}} onFocusBand={() => {}} t={t as ResearchT} />,
    )
    expect(focused).toContain('data-dimmed="true"')

    const plain = renderToString(
      <EvidenceGraphCanvas layout={layout} selectedId={null} focusedBandKey={null} onSelect={() => {}} onFocusBand={() => {}} t={t as ResearchT} />,
    )
    expect(plain).not.toContain('data-dimmed="true"')
  })

  it('renders a clickable band header hit target', () => {
    const layout = deriveEvidenceGraphLayout(TWO_BANDS)
    const html = renderToString(
      <EvidenceGraphCanvas layout={layout} selectedId={null} focusedBandKey={null} onSelect={() => {}} onFocusBand={() => {}} t={t as ResearchT} />,
    )
    expect(html).toContain('evidenceBandHeadHit')
  })
})

describe('EvidenceGraphCanvas declared line-state glyphs', () => {
  it('renders ✗ for a failed line and ✓ for an adopted one, none for open', () => {
    const failed = deriveEvidenceGraphLayout(FIXTURE, { lineStates: new Map([['idea:1', { status: 'failed', idleDays: null }]]) })
    const failedHtml = renderToString(<EvidenceGraphCanvas layout={failed} selectedId={null} onSelect={() => {}} t={t as ResearchT} />)
    expect(failedHtml).toContain('evidenceBandStatus')
    expect(failedHtml).toContain('✗')

    const adopted = deriveEvidenceGraphLayout(FIXTURE, { lineStates: new Map([['idea:1', { status: 'adopted', idleDays: null }]]) })
    const adoptedHtml = renderToString(<EvidenceGraphCanvas layout={adopted} selectedId={null} onSelect={() => {}} t={t as ResearchT} />)
    expect(adoptedHtml).toContain('✓')

    const open = deriveEvidenceGraphLayout(FIXTURE, { lineStates: new Map([['idea:1', { status: 'open', idleDays: 5 }]]) })
    const openHtml = renderToString(<EvidenceGraphCanvas layout={open} selectedId={null} onSelect={() => {}} t={t as ResearchT} />)
    expect(openHtml).not.toContain('evidenceBandStatus')
    expect(openHtml).toContain(t('evidence.graph.idle', { days: '5' }))
  })
})
