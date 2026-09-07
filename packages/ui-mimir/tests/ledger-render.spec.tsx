/**
 * Render smoke for the ledger view's derived cards: server-renders the real
 * LedgerView with ready worktree (S2) + foraging (S4) slices and asserts the
 * storyline strip, the territory ledger, and the GUT copy actually reach
 * HTML. Guards against render-time crashes that pure-logic tests cannot see
 * (found once in the batch-5 audit: a storyline tooltip calling
 * Date#toISOString on a millisecond number). Stubbed slice data only; the
 * full real-service path is exercised by the mimir-side wiring tests.
 * @module dsh-client-ui-mimir/tests/ledger-render.spec
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type {
  ResearchForagingView,
  ResearchWorktreeView,
} from 'dsh-mimir/types'
import { LedgerView } from '../src/client/LedgerView.tsx'
import type {
  ResearchBriefView,
  ResearchDigestSlice,
  ResearchForagingSlice,
  ResearchLedgerView,
  ResearchMomentsSlice,
  ResearchReportView,
  ResearchWorktreeSlice,
} from '../src/client/controller.ts'
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

const DAY = 86_400_000
const NOW = '2026-08-27T10:00:00.000Z'
const nowMs = Date.parse(NOW)
const iso = (daysAgo: number): string => new Date(nowMs - daysAgo * DAY).toISOString()

const WORKTREE: ResearchWorktreeView = {
  derivedAt: NOW,
  lanes: [
    {
      lineId: 'i1', label: 'Chunk-graph reranking', status: 'open', state: 'dominant',
      parentLineId: null, parentLabel: null,
      firstSeen: iso(12), lastSeen: iso(0), eventCount: 3, drift: 1.9,
      closedAt: null, closeReason: null, gutDays: null, idleDays: 0,
      touches: [
        { at: iso(12), kind: 'create', action: 'knowledge.idea.added' },
        { at: iso(6), kind: 'work', action: 'experiments.saved' },
        { at: iso(0), kind: 'terminal', action: 'knowledge.idea.failed' },
      ],
    },
    {
      lineId: 'i2', label: 'Hybrid sparse-dense routing', status: 'failed', state: 'settled',
      parentLineId: 'i1', parentLabel: 'Chunk-graph reranking',
      firstSeen: iso(10), lastSeen: iso(2), eventCount: 2, drift: -0.8,
      closedAt: iso(0), closeReason: 'no measurable gain', gutDays: 2, idleDays: null,
      touches: [
        { at: iso(10), kind: 'create', action: 'knowledge.idea.added' },
        { at: iso(2), kind: 'work', action: 'experiments.saved' },
        { at: iso(0), kind: 'terminal', action: 'knowledge.idea.failed' },
      ],
    },
    {
      lineId: 'i3', label: 'Late-interaction pooling', status: 'adopted', state: 'settled',
      parentLineId: 'i1', parentLabel: 'Chunk-graph reranking',
      firstSeen: iso(8), lastSeen: iso(3), eventCount: 2, drift: 0.9,
      closedAt: null, closeReason: null, gutDays: null, idleDays: null,
      touches: [
        { at: iso(8), kind: 'create', action: 'knowledge.idea.added' },
        { at: iso(4), kind: 'terminal', action: 'knowledge.idea.failed' },
      ],
    },
    {
      lineId: 'project:p1', label: 'Long-context retrieval', status: 'open', state: 'converging',
      parentLineId: null, parentLabel: null,
      firstSeen: iso(9), lastSeen: iso(1), eventCount: 5, drift: 2.2,
      closedAt: null, closeReason: null, gutDays: null, idleDays: 1,
      touches: [{ at: iso(9), kind: 'create', action: 'knowledge.idea.added' }, { at: iso(1), kind: 'work', action: 'experiments.saved' }],
    },
  ],
  mainline: { lineId: 'i1', label: 'Chunk-graph reranking', declaredAt: iso(0) },
  mainlineHistory: [{ lineId: 'i1', label: 'Chunk-graph reranking', declaredAt: iso(0) }],
  counts: { open: 2, failed: 1, adopted: 1 },
}

const FORAGING: ResearchForagingView = {
  derivedAt: NOW,
  territories: [
    {
      projectId: 'p1', label: 'Long-context retrieval', eventCount: 12,
      firstSeen: iso(9), lastSeen: iso(1), activityMass: 4.2,
      harvestCount: 1, lastHarvestAt: iso(5), daysSinceHarvest: 5, daysSinceActivity: 1,
    },
    {
      projectId: 'p2', label: 'Claim atlas', eventCount: 0,
      firstSeen: '', lastSeen: '', activityMass: 0,
      harvestCount: 0, lastHarvestAt: null, daysSinceHarvest: null, daysSinceActivity: 0,
    },
  ],
  baseline: { samples: 5, medianDays: 6, iqrDays: 4, minSamples: 5, speaks: true },
  cards: [
    { projectId: 'p1', label: 'Long-context retrieval', daysSinceHarvest: 5, daysSinceActivity: 1, baselineMedianDays: 6 },
    { projectId: 'p2', label: 'Claim atlas', daysSinceHarvest: null, daysSinceActivity: 0, baselineMedianDays: 6 },
  ],
}

describe('LedgerView render smoke (S2 branch flow + S4 rhythm)', () => {
  it('renders the branch flow and the rhythm card without crashing', () => {
    const coldLedger: ResearchLedgerView = { status: 'cold', list: [], failure: null }
    const coldReport: ResearchReportView = { status: 'idle', markdown: '', generatedAt: null, eventCount: null, failure: null }
    const coldBrief: ResearchBriefView = {
      status: 'idle', markdown: '', generatedAt: null, eventCount: null,
      derivationVersion: null, recalibrated: false, questions: [], failure: null,
    }
    const coldMoments: ResearchMomentsSlice = { status: 'cold', view: null, failure: null }
    const coldDigest: ResearchDigestSlice = {
      status: 'idle', tier: 'weekly', lang: 'zh', report: null, markdown: '', generatedAt: null, failure: null,
    }
    const html = renderToString(
      <LedgerView
        ledger={coldLedger}
        report={coldReport}
        brief={coldBrief}
        worktree={{ status: 'ready', view: WORKTREE, failure: null } as ResearchWorktreeSlice}
        foraging={{ status: 'ready', view: FORAGING, failure: null } as ResearchForagingSlice}
        moments={coldMoments}
        digest={coldDigest}
        selectedProjectId={null}
        loadLedger={() => {}}
        generateReport={async () => null}
        generateBrief={async () => null}
        addJournal={async () => null}
        ensureWorktree={() => {}}
        refreshWorktree={() => {}}
        setMainline={async () => null}
        setIdeaParent={async () => null}
        adoptIdea={async () => null}
        closeIdea={async () => null}
        ensureForaging={() => {}}
        refreshForaging={() => {}}
        ensureMoments={() => {}}
        refreshMoments={() => {}}
        declineMoment={async () => null}
        ensureDigest={() => {}}
        refreshDigest={() => {}}
        generateDigest={async () => null}
        setEureka={async () => null}
        pinMoment={async () => null}
        t={t as ResearchT}
      />,
    )

    // Worktree: title, banner, and the storyline SVG with its lane glyphs.
    expect(html).toContain('科研工作树')
    expect(html).toContain('主线')
    expect(html).toContain('<svg')
    expect(html).toContain('●')
    expect(html).toContain('✗')
    // The epoch rules and the now-line are the graph's verticals.
    expect(html.match(/<line/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // The branch flow: fat curves + beads reach HTML; NO text inside the SVG
    // (labels/glyphs removed — status speaks through shape and color).
    expect(html).toContain('worktreeFlowCurve')
    expect(html).toContain('worktreeFlowMain')
    expect(html).toContain('worktreeFlowDead')
    expect(html.match(/<path/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    // Every curve carries fill="none" as an ATTRIBUTE — the black-wedge bug
    // (paths filling black whenever the stylesheet fails to apply) can
    // never recur, in any environment.
    expect(html.match(/<path[^>]*fill="none"/g)?.length ?? 0)
      .toBe(html.match(/<path/g)?.length ?? 0)
    expect(html.match(/<circle/g)?.length ?? 0).toBeGreaterThanOrEqual(8)
    expect(html).not.toContain('worktreeGraphLabel')
    expect(html).toContain('研究分支图')
    // Bead titles carry localized action labels (hover info), not raw ids.
    expect(html).toContain('新增想法')
    expect(html).toContain('保存实验')
    expect(html).toContain('曲线=研究线')
    // An adopted lane reaches HTML with its merge glyph.
    expect(html).toContain('已并入（✓）')
    expect(html).toContain('Late-interaction pooling')
    // Lane tooltips keep formatting ISO dates (the audit's crash spot).

    // Foraging: title, the speaking baseline, both territories, the GUT copy.
    expect(html).toContain('研究节奏')
    expect(html).toContain('中位 6 天')
    expect(html).toContain('四分位距 4 天')
    expect(html).toContain('5 次有据的离开')
    expect(html).toContain('距上次收获 5 天')
    expect(html).toContain('离开间隔中位 6 天')
    expect(html).toContain('Claim atlas')
    expect(html).toContain('还没有动态')
    expect(html).toContain('两个数字，零动词')
  })
})
