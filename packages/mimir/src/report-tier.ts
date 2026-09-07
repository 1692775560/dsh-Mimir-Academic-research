/**
 * CBE digest assembly (S8c): the weekly / monthly / project report as one
 * pure fold over the ledger plus the wiki and the papers table. The engine
 * does no thinking of its own — it collects the six-perspective capsules
 * (report-capsules.ts) and, per tier, decides HOW MANY of each to show and
 * whether the heavier furniture (the Eureka EWS table, the Mermaid worktree
 * graph) belongs on the page. A weekly report is light; a project summary is
 * heavy. That depth gradient is the only thing this module adds on top of
 * the capsule fold — everything it reports is a re-derivation, never a fact.
 *
 * Honesty carried from the rest of the engine:
 *  - **PRISMA-style retrieval declaration** leads every report: where the
 *    data came from, how many events hit, and — crucially — which layers
 *    stayed SILENT and why. A silent layer is not a missing section; it is a
 *    registered bias, and the report says so in plain text.
 *  - **EWS is descriptive here.** The project tier's Eureka table shows each
 *    declared milestone's lead-in entropy against its paired control — a
 *    description of roads already walked. It never says "you are next".
 *  - **G0 still holds**: the assembled model is a plain data object; nothing
 *    here is gated behind a UI flag because nothing here is a prediction.
 * @module dsh-mimir/src/report-tier
 */

import { CBE_DERIVATION_VERSION, deriveBrief } from './cognitive-map.ts'
import type { CbeWikiSnapshot } from './cognitive-map.ts'
import { deriveCuratedMoments } from './moment-index.ts'
import { deriveHabits, CBE_HABIT_MIN_SESSIONS } from './habits.ts'
import { deriveLibraryThemes, CBE_THEME_MIN_PAPERS } from './library-themes.ts'
import type { PaperRecord } from './types.ts'
import { deriveWorktree } from './worktree.ts'
import {
  CBE_EUREKA_MIN_DECLARATIONS,
  eurekaDeclarations,
  eurekaModelAt,
} from './eureka.ts'
import {
  deriveCapsules,
  type CbeCapsulePerspective,
  type CbeExperienceCapsule,
} from './report-capsules.ts'
import { CREATION_ACTIONS } from './vocabulary.ts'
import type { EventRecord } from './types.ts'
import { sliceEvents, tsToMs } from './time.ts'

/** The three report depths (light → heavy). */
export type CbeDigestTier = 'weekly' | 'monthly' | 'project'

/** One top-line number on the report's front matter. */
export interface CbeDigestStat {
  readonly key: string
  readonly label: { readonly zh: string; readonly en: string }
  readonly value: string
}

/** The PRISMA-style "where did this come from" banner. */
export interface CbeDigestRetrieval {
  readonly source: string
  readonly since: string
  readonly until: string
  readonly eventsHit: number
  readonly eventsTotal: number
  readonly derivationVersion: number
  /** Layers that stayed silent this window, with the reason each is quiet. */
  readonly silences: readonly string[]
}

/** One Eureka milestone and the entropy it led in with (descriptive only). */
export interface CbeDigestEurekaRow {
  readonly index: number
  readonly at: string
  readonly title: string
  /** H(k) in the lead-in window (bits), or null when the sample was too small. */
  readonly leadEntropyRate: number | null
  /** H(k) in the paired control window (bits), or null. */
  readonly controlEntropyRate: number | null
  /** Mean −log₂ p in the lead-in window (bits), or null. */
  readonly leadMeanSurprisal: number | null
  /** Mean −log₂ p in the paired control window (bits), or null. */
  readonly controlMeanSurprisal: number | null
}

/** One perspective block: its capsules, already tier-capped. */
export interface CbeDigestPerspectiveBlock {
  readonly perspective: CbeCapsulePerspective
  readonly label: { readonly zh: string; readonly en: string }
  readonly capsules: readonly CbeExperienceCapsule[]
}

/** The whole assembled report model (rendered by render-digest.ts or the panel). */
export interface CbeDigestReport {
  readonly tier: CbeDigestTier
  readonly asOf: string
  readonly window: { readonly since: string; readonly until: string }
  readonly retrieval: CbeDigestRetrieval
  readonly overview: readonly CbeDigestStat[]
  readonly perspectives: readonly CbeDigestPerspectiveBlock[]
  /** Empty unless tier is 'project'. Descriptive EWS, never a prediction. */
  readonly eurekaTable: readonly CbeDigestEurekaRow[]
  /** A Mermaid gitGraph of the worktree, or null unless tier is 'project'. */
  readonly mermaid: string | null
}

/** The assembled report's inputs (kept minimal so the fold is testable). */
export interface DigestInput {
  readonly events: readonly EventRecord[]
  readonly wiki: CbeWikiSnapshot
  readonly papers: readonly PaperRecord[]
  readonly since: string
  readonly until: string
  readonly tier: CbeDigestTier
  readonly nowMs: number
  /**
   * The TRUE number of events the window matched, when the caller already
   * knows it (e.g. the ledger's honest `countEvents`). When omitted,
   * `assembleDigest` falls back to `events.length` — which is the CAPPED
   * stream it was handed, not the ledger, and would let a truncation pass
   * itself off as the whole history. The one production caller passes the
   * real total so the retrieval line stays honest even past the fold cap.
   */
  readonly eventsTotal?: number
  /**
   * An OPTIONAL extended event set handed to the eureka fold only. Eureka
   * reads a control window of `2 × CBE_EUREKA_WINDOW_DAYS` BEFORE each
   * declaration; a short digest window would make those controls "unobservable"
   * and silently drop declarations. The caller may pass a longer lookback here
   * while the other — window-scoped — folds keep using `events`. When omitted,
   * eureka uses `events` like every other fold.
   */
  readonly eurekaEvents?: readonly EventRecord[]
}

/** Cap per perspective, by tier (Infinity = show all). */
const TIER_CAPS: Readonly<Record<CbeDigestTier, Partial<Record<CbeCapsulePerspective, number>>>> = {
  weekly: { mainline: 3, moment: 3 },
  monthly: { mainline: 5, moment: 5, 'dead-branch': Number.POSITIVE_INFINITY, literature: 5, rhythm: Number.POSITIVE_INFINITY, 'open-loop': Number.POSITIVE_INFINITY },
  project: {
    mainline: Number.POSITIVE_INFINITY,
    'dead-branch': Number.POSITIVE_INFINITY,
    literature: Number.POSITIVE_INFINITY,
    rhythm: Number.POSITIVE_INFINITY,
    moment: Number.POSITIVE_INFINITY,
    'open-loop': Number.POSITIVE_INFINITY,
  },
}

/** Which overview stats each tier surfaces. */
const TIER_STATS: Readonly<Record<CbeDigestTier, readonly string[]>> = {
  weekly: ['events', 'creations', 'pinnedMoments'],
  monthly: ['events', 'creations', 'pinnedMoments', 'deadBranches', 'papers'],
  project: ['events', 'creations', 'mainlineActive', 'deadBranches', 'papers', 'pinnedMoments', 'openLoops', 'eurekas', 'longestSession'],
}

/** Round to 1 decimal for stable stat strings. */
function r1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Assemble the full report model for one window and tier. Pure: given the
 * same inputs it returns the same model, and it writes nothing.
 * @param input - events, wiki, papers, window bounds, tier, and "now".
 * @returns the frozen report model.
 */
export function assembleDigest(input: DigestInput): CbeDigestReport {
  const { events, wiki, papers, since, until, tier, nowMs } = input
  const sinceMs = tsToMs(since) ?? 0
  const untilMs = tsToMs(until) ?? nowMs

  // The shared slice, so this report counts exactly the events every other
  // fold counts for the same bounds.
  const inWindow = sliceEvents(events, sinceMs, untilMs)
  // The whole creation class, as the vocabulary defines it. This used to list
  // three of the six members by hand, which under-reported "新建" on every
  // digest that imported a paper or saved a figure.
  const creations = inWindow.filter(event => CREATION_ACTIONS.has(event.action)).length

  const worktree = deriveWorktree(events, wiki, nowMs)
  const moments = deriveCuratedMoments(events, since, until)
  const library = deriveLibraryThemes(papers, since, until, nowMs)
  const habits = deriveHabits(events, since, until, nowMs)
  const brief = deriveBrief(events, wiki, { since, until, projectId: null }, nowMs)
  const allCapsules = deriveCapsules({ window: { since, until }, worktree, moments, library, habits, brief })
  // Eureka needs the lead-in AND control windows: a declaration at `at` reads
  // `2 × CBE_EUREKA_WINDOW_DAYS` of history BEFORE it (see `eureka.ts`). The
  // digest window is often shorter (a weekly digest), so the caller may hand
  // an extended lookback here that the other — window-scoped — folds never
  // see. Falls back to the window events when no lookback was provided.
  const eurekaSource = input.eurekaEvents ?? events
  const eurekas = eurekaDeclarations(eurekaSource)
  const eurekaModel = eurekaModelAt(eurekaSource)

  // Tier-capped perspective blocks.
  const caps = TIER_CAPS[tier]
  const byPerspective = new Map<CbeCapsulePerspective, CbeExperienceCapsule[]>()
  for (const capsule of allCapsules) {
    const list = byPerspective.get(capsule.perspective) ?? []
    list.push(capsule)
    byPerspective.set(capsule.perspective, list)
  }
  const perspectiveOrder: readonly CbeCapsulePerspective[] = ['mainline', 'dead-branch', 'literature', 'rhythm', 'moment', 'open-loop']
  const perspectives: CbeDigestPerspectiveBlock[] = []
  for (const perspective of perspectiveOrder) {
    const list = byPerspective.get(perspective)
    if (list === undefined || list.length === 0) continue
    const cap = caps[perspective] ?? 0
    const shown = list.slice(0, Number.isFinite(cap) ? cap : list.length)
    if (shown.length === 0) continue
    perspectives.push(Object.freeze({
      perspective,
      label: PERSPECTIVE_LABELS[perspective],
      capsules: Object.freeze(shown),
    }))
  }

  // Overview stats (tier-selected).
  const mainlineActive = worktree.lanes.filter(lane => lane.status === 'open' || lane.status === 'adopted').length
  const deadBranches = worktree.counts.failed
  const pinnedMoments = moments.filter(moment => moment.pinned).length
  const openLoops = brief.openLoops.length
  const eurekaCount = eurekas.filter(decl => {
    const ms = tsToMs(decl.at)
    return ms !== null && ms >= sinceMs && ms < untilMs
  }).length
  const statPool: Record<string, CbeDigestStat> = {
    events: { key: 'events', label: { zh: '窗口事件', en: 'events' }, value: String(inWindow.length) },
    creations: { key: 'creations', label: { zh: '新建', en: 'creations' }, value: String(creations) },
    mainlineActive: { key: 'mainlineActive', label: { zh: '活跃主线', en: 'live lines' }, value: String(mainlineActive) },
    deadBranches: { key: 'deadBranches', label: { zh: '已终止分支', en: 'dead branches' }, value: String(deadBranches) },
    papers: { key: 'papers', label: { zh: '新增文献', en: 'papers' }, value: String(library.current.paperCount) },
    pinnedMoments: { key: 'pinnedMoments', label: { zh: '已钉住瞬间', en: 'pinned moments' }, value: String(pinnedMoments) },
    openLoops: { key: 'openLoops', label: { zh: '未收的尾', en: 'open loops' }, value: String(openLoops) },
    eurekas: { key: 'eurekas', label: { zh: 'Eureka 里程碑', en: 'eurekas' }, value: String(eurekaCount) },
    longestSession: {
      key: 'longestSession',
      label: { zh: '最长一次', en: 'longest sit' },
      value: habits.longestSessionMinutes === null ? '—' : `${r1(habits.longestSessionMinutes)}m`,
    },
  }
  const overview = TIER_STATS[tier].map(key => statPool[key]).filter((stat): stat is CbeDigestStat => stat !== undefined)

  // Retrieval declaration + registered silences.
  const silences: string[] = []
  if (!habits.speaks) silences.push(`habits 沉默（会话 < ${CBE_HABIT_MIN_SESSIONS}）`)
  if (!library.speaks) silences.push(`themes 沉默（论文 < ${CBE_THEME_MIN_PAPERS}）`)
  if (eurekaModel.leads.length < CBE_EUREKA_MIN_DECLARATIONS) {
    silences.push(`eureka 沉默（宣告 < ${CBE_EUREKA_MIN_DECLARATIONS}）`)
  }
  const retrieval: CbeDigestRetrieval = Object.freeze({
    source: 'events 表',
    since,
    until,
    eventsHit: inWindow.length,
    eventsTotal: input.eventsTotal ?? events.length,
    derivationVersion: CBE_DERIVATION_VERSION,
    silences: Object.freeze(silences),
  })

  // Eureka EWS table + Mermaid — project tier only, both purely descriptive.
  // Only declarations that actually fall inside the digest window belong in
  // the table; the eureka model may have been folded over a longer lookback,
  // so pre-window declarations (kept only to anchor the control baseline) are
  // filtered out. The lead/control vectors stay aligned to their declaration
  // by carrying the original row index through the filter.
  const eurekaTable = tier === 'project'
    ? eurekaModel.declarations
      .map((decl, index) => ({
        decl,
        lead: eurekaModel.leads[index],
        control: eurekaModel.controls[index],
        row: index + 1,
      }))
      .filter(({ decl }) => {
        const ms = tsToMs(decl.at)
        return ms !== null && ms >= sinceMs && ms < untilMs
      })
      .map(({ decl, lead, control, row }) => Object.freeze({
        index: row,
        at: decl.at,
        title: decl.title,
        leadEntropyRate: lead?.conditionalEntropy ?? null,
        controlEntropyRate: control?.conditionalEntropy ?? null,
        leadMeanSurprisal: lead?.meanSurprisal ?? null,
        controlMeanSurprisal: control?.meanSurprisal ?? null,
      }))
    : []
  const mermaid = tier === 'project' ? buildWorktreeMermaid(worktree) : null

  return Object.freeze({
    tier,
    asOf: new Date(nowMs).toISOString(),
    window: { since, until },
    retrieval,
    overview: Object.freeze(overview),
    perspectives: Object.freeze(perspectives),
    eurekaTable: Object.freeze(eurekaTable),
    mermaid,
  })
}

/** Locale-aware perspective labels. */
const PERSPECTIVE_LABELS: Record<CbeCapsulePerspective, { zh: string; en: string }> = {
  mainline: { zh: '主线推进', en: 'Mainline progress' },
  'dead-branch': { zh: '死叉教训', en: 'Dead-branch lessons' },
  literature: { zh: '文献摄入', en: 'Literature intake' },
  rhythm: { zh: '习惯节律', en: 'Working rhythm' },
  moment: { zh: '值得记住的瞬间', en: 'Memorable moments' },
  'open-loop': { zh: '未收的尾', en: 'Open loops' },
}

/** Sanitize a lane id into a Mermaid-safe branch name. */
function safeBranch(lineId: string): string {
  return lineId.replace(/[^A-Za-z0-9_]/g, '_')
}

/**
 * A decorative Mermaid gitGraph of the worktree: mainline plus one branch per
 * lane, each with a single commit at its first-seen. Topology is simplified
 * (every lane branches from main); it is a shape to glance at, not a faithful
 * commit graph. Capped at 12 lanes so the diagram stays legible.
 */
function buildWorktreeMermaid(worktree: ReturnType<typeof deriveWorktree>): string {
  const lines: string[] = ['gitGraph', '  commit id: "root"']
  if (worktree.mainline !== null) {
    lines.push('  branch main')
    lines.push(`  commit id: "${safeBranch(worktree.mainline.lineId).slice(0, 12)}"`)
  }
  let count = 0
  for (const lane of worktree.lanes) {
    if (worktree.mainline !== null && lane.lineId === worktree.mainline.lineId) continue
    if (count >= 12) break
    const branch = safeBranch(lane.lineId).slice(0, 12) || `lane${count}`
    lines.push('  checkout main')
    lines.push(`  branch ${branch}`)
    lines.push(`  commit id: "${branch}"`)
    count += 1
  }
  return lines.join('\n')
}
