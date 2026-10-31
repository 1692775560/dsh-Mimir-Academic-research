/**
 * Pure layout for the worktree's branch flow — the git-workflowillustration
 * form (fat colored curves ballooning off a main axis and merging back),
 * clay skin applied at render: time flows left→right (compressed, one
 * column per moment batch), the mainline-declared lane rides the axis, every
 * other research line bows out to its own amplitude and either merges back
 * (adopted), ends with its documented No (failed), or runs to the now-line
 * (open). Every work node is a bead ON its curve (terminal > create >
 * work > meta on the bead scale). NO TEXT lives in the SVG — status speaks
 * through shape and color; names and magnitudes stay in the lane list.
 *
 * Deterministic and order-independent: a pure fold over the worktree view.
 * NOTHING here infers structure: only user-declared parent edges shape the
 * curves; a dangling or cyclic declaration degrades to a root, never a
 * crash. Presentation constants only — no CBE-governed scalars live here.
 * @module dsh-client-ui-mimir/client/worktree-map
 */

import type {
  ResearchWorktreeLaneView,
  ResearchWorktreeTouchKind,
  ResearchWorktreeView,
} from 'dsh-mimir/types'
import { lineHueOf } from './line-hue.ts'

/** Time-column budget (moments beyond it fold into shared columns). */
export const WORKTREE_FLOW_MAX_COLS = 36
/** Map width in viewBox units. */
const WORKTREE_FLOW_W = 640
/** Vertical spacing between amplitude levels. */
const WORKTREE_FLOW_AMP = 26
/** Fork/merge bow width in viewBox units. */
const WORKTREE_FLOW_BOW = 17
/**
 * The lane palette: six bright, friendly hues borrowed from the clean
 * branch-graph vocabulary — saturated enough to act as category labels,
 * but flat (no gradients) so the white-ringed nodes read clearly against
 * the light grey connectors.
 */
const WORKTREE_FLOW_PALETTE: readonly string[] = Object.freeze([
  '#FF7F6E', // coral — mainline energy
  '#5AB4F2', // blue — open lanes
  '#6ABF7A', // green — adopted / merged
  '#F7C566', // yellow — attention / epochs
  '#F07C9C', // pink — failed / documented No
  '#7B7FEA', // purple — side roads
])

const PAD_X = 14
const PAD_Y = 18

function parseMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** One placed research line: its whole curve, plus the straight-section
 *  span where its beads ride. */
export interface WorktreeFlowLane {
  readonly lane: ResearchWorktreeLaneView
  readonly color: string
  readonly isMain: boolean
  /** The full SVG path (M … Q … L …, merging lines curve back to parent). */
  readonly path: string
  /** The curve's straight-section y (where beads sit). */
  readonly y: number
}

/** One work node: a bead on its curve at a compressed column. */
export interface WorktreeFlowBead {
  readonly lineId: string
  readonly x: number
  readonly y: number
  readonly kind: ResearchWorktreeTouchKind
  readonly at: string
  /** The action behind the bead's earliest touch (labels client-side). */
  readonly action: string
  readonly count: number
  readonly color: string
}

/** One mainline-declaration epoch (a dashed vertical). */
export interface WorktreeFlowEpoch {
  readonly x: number
  readonly label: string
  readonly at: string
}

/** The whole flow geometry, ready for one deterministic SVG render. */
export interface WorktreeFlowLayout {
  readonly width: number
  readonly height: number
  readonly cols: number
  readonly momentCount: number
  readonly mainY: number
  readonly lanes: readonly WorktreeFlowLane[]
  readonly beads: readonly WorktreeFlowBead[]
  readonly epochs: readonly WorktreeFlowEpoch[]
  readonly nowX: number
}

const BEAD_RANK: Readonly<Record<ResearchWorktreeTouchKind, number>> = {
  terminal: 3, create: 2, work: 1, meta: 0,
}

/** Bead radius on the bead scale (bumped when a column merged several). */
export function beadRadius(kind: ResearchWorktreeTouchKind, count: number): number {
  const base = kind === 'terminal' ? 4.6 : kind === 'create' ? 3.8 : kind === 'work' ? 2.8 : 2.1
  return count > 1 ? base + 0.7 : base
}

/**
 * @param view - the derived worktree (lanes in ANY order; sorted internally).
 * @returns the deterministic flow layout (empty lanes when nothing parses).
 */
export function layoutWorktreeFlow(view: ResearchWorktreeView): WorktreeFlowLayout {
  const mainlineId = view.mainline?.lineId ?? null

  const candidates = new Map<string, ResearchWorktreeLaneView>()
  for (const lane of view.lanes) {
    if (parseMs(lane.firstSeen) === null) continue
    candidates.set(lane.lineId, lane)
  }

  // ── The declared forest: preorder walk, roots by first touch.
  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []
  for (const [lineId, lane] of candidates) {
    const parent = lane.parentLineId
    if (parent !== null && parent !== lineId && candidates.has(parent)) {
      const list = childrenOf.get(parent) ?? []
      list.push(lineId)
      childrenOf.set(parent, list)
      continue
    }
    roots.push(lineId)
  }
  const firstMsOf = (lineId: string): number => parseMs(candidates.get(lineId)?.firstSeen ?? '') ?? 0
  const byFirst = (a: string, b: string): number => firstMsOf(a) - firstMsOf(b) || a.localeCompare(b)
  roots.sort(byFirst)
  for (const list of childrenOf.values()) list.sort(byFirst)
  const ordered: string[] = []
  const visited = new Set<string>()
  const walk = (lineId: string): void => {
    if (visited.has(lineId)) return
    visited.add(lineId)
    ordered.push(lineId)
    for (const child of childrenOf.get(lineId) ?? []) walk(child)
  }
  for (const root of roots) walk(root)
  for (const lineId of [...candidates.keys()].filter(id => !visited.has(id)).sort(byFirst)) walk(lineId)

  // ── Time compression: every moment folds into ≤ MAX_COLS columns.
  const moments = new Set<string>()
  for (const lane of candidates.values()) {
    moments.add(lane.firstSeen)
    moments.add(lane.closedAt ?? lane.lastSeen)
    for (const touch of lane.touches) moments.add(touch.at)
  }
  for (const declaration of view.mainlineHistory) moments.add(declaration.declaredAt)
  moments.add(view.derivedAt)
  const sorted = [...moments].sort()
  const cols = Math.min(sorted.length, WORKTREE_FLOW_MAX_COLS)
  const colIndexOf = (ts: string): number => {
    let low = 0
    let high = sorted.length - 1
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (sorted[mid]! < ts) low = mid + 1
      else high = mid
    }
    return low
  }
  const colOf = (ts: string): number =>
    Math.min(cols - 1, Math.floor(colIndexOf(ts) * cols / sorted.length))
  const xOf = (col: number): number => PAD_X + (col / Math.max(1, cols - 1)) * (WORKTREE_FLOW_W - PAD_X * 2)

  // ── Amplitudes: the mainline lane rides the axis; every other lane takes
  //    a UNIQUE rail slot (side + level), children nesting beyond their
  //    parent, filling the emptier side first — no two lanes ever share a
  //    rail, and siblings stay on their parent's side of the axis.
  const levelOf = new Map<string, number>()
  const sideOf = new Map<string, number>()
  const parentOf = new Map<string, string>()
  const nextSlot = new Map<number, number>([[-1, 1], [1, 1]])
  const emptierSide = (): number =>
    (nextSlot.get(-1) ?? 1) <= (nextSlot.get(1) ?? 1) ? -1 : 1
  for (const lineId of ordered) {
    const parent = candidates.get(lineId)?.parentLineId ?? null
    const hasParent = parent !== null && parent !== lineId && levelOf.has(parent)
    parentOf.set(lineId, hasParent ? parent : '')
    if (lineId === mainlineId) {
      levelOf.set(lineId, 0)
      sideOf.set(lineId, 0)
      continue
    }
    let side: number
    let level: number
    if (hasParent) {
      const parentSide = sideOf.get(parent) ?? 0
      side = parentSide !== 0 ? parentSide : emptierSide()
      level = Math.max((levelOf.get(parent) ?? 0) + 1, nextSlot.get(side) ?? 1)
    } else {
      side = emptierSide()
      level = Math.max(1, nextSlot.get(side) ?? 1)
    }
    levelOf.set(lineId, level)
    sideOf.set(lineId, side)
    nextSlot.set(side, level + 1)
  }

  // The axis sits so the busiest side fits: up levels above, down below.
  let up = 0
  let down = 0
  for (const lineId of ordered) {
    const level = levelOf.get(lineId) ?? 0
    const side = sideOf.get(lineId) ?? 0
    if (side < 0) up = Math.max(up, level)
    if (side > 0) down = Math.max(down, level)
  }
  const mainY = PAD_Y + up * WORKTREE_FLOW_AMP
  const height = mainY + down * WORKTREE_FLOW_AMP + PAD_Y
  const yOfLane = (lineId: string): number =>
    mainY + (sideOf.get(lineId) ?? 0) * (levelOf.get(lineId) ?? 0) * WORKTREE_FLOW_AMP

  // ── Curves + straight sections.
  const lanes: WorktreeFlowLane[] = []
  const sectionOf = new Map<string, { xs: number; xe: number; y: number }>()
  for (const lineId of ordered) {
    const lane = candidates.get(lineId)
    if (lane === undefined) continue
    const x0 = xOf(colOf(lane.firstSeen))
    const xEnd = xOf(colOf(lane.closedAt ?? lane.lastSeen))
    const y = yOfLane(lineId)
    const parent = parentOf.get(lineId) ?? ''
    const curves = parent !== '' && levelOf.get(parent) !== undefined
    const yS = curves ? mainY + (sideOf.get(parent) ?? 0) * (levelOf.get(parent) ?? 0) * WORKTREE_FLOW_AMP : y
    const bow = Math.min(WORKTREE_FLOW_BOW, Math.max(0, (xEnd - x0) / 3))
    const xs = curves ? Math.min(x0 + bow * 1.6, xEnd) : x0
    const adopted = lane.status === 'adopted' && curves
    const xe = adopted ? Math.max(xs, xEnd - bow * 1.6) : xEnd
    let path: string
    if (!curves || yS === y) {
      path = `M ${String(x0)} ${String(y)} L ${String(xEnd)} ${String(y)}`
    } else {
      path = `M ${String(x0)} ${String(yS)} Q ${String(x0 + bow)} ${String(yS)} ${String(xs)} ${String(y)} L ${String(xe)} ${String(y)}`
      if (adopted) {
        path += ` Q ${String(Math.max(xe, xEnd - bow))} ${String(yS)} ${String(xEnd)} ${String(yS)}`
      }
    }
    // Stable identity hue: a re-parented or newly added line keeps its color
    // (and matches the Evidence Graph's band hue for the same research line).
    lanes.push({
      lane,
      color: WORKTREE_FLOW_PALETTE[lineHueOf(lineId, WORKTREE_FLOW_PALETTE.length)] ?? '#9aa3b8',
      isMain: lineId === mainlineId,
      path,
      y,
    })
    sectionOf.set(lineId, { xs, xe: adopted ? xe : xEnd, y })
  }

  // ── Beads ride their curve's straight section (clamped into it).
  const beads: WorktreeFlowBead[] = []
  for (const entry of lanes) {
    const section = sectionOf.get(entry.lane.lineId)
    if (section === undefined) continue
    const byCol = new Map<number, { at: string; kind: ResearchWorktreeTouchKind; action: string; count: number }>()
    for (const touch of entry.lane.touches) {
      const col = colOf(touch.at)
      const slot = byCol.get(col)
      if (slot === undefined) {
        byCol.set(col, { at: touch.at, kind: touch.kind, action: touch.action, count: 1 })
        continue
      }
      slot.count += 1
      if (BEAD_RANK[touch.kind] > BEAD_RANK[slot.kind]) slot.kind = touch.kind
      if (touch.at < slot.at) {
        slot.at = touch.at
        slot.action = touch.action // the action stays paired with the earliest ts
      }
    }
    for (const [col, slot] of byCol) {
      const x = Math.min(Math.max(xOf(col), section.xs), section.xe)
      beads.push({
        lineId: entry.lane.lineId,
        x,
        y: section.y,
        kind: slot.kind,
        at: slot.at,
        action: slot.action,
        count: slot.count,
        color: entry.color,
      })
    }
  }

  const epochs: WorktreeFlowEpoch[] = view.mainlineHistory.map(declaration => ({
    x: xOf(colOf(declaration.declaredAt)),
    label: declaration.label,
    at: declaration.declaredAt,
  }))

  return Object.freeze({
    width: WORKTREE_FLOW_W,
    height,
    cols,
    momentCount: sorted.length,
    mainY,
    lanes: Object.freeze(lanes),
    beads: Object.freeze(beads),
    epochs: Object.freeze(epochs),
    nowX: xOf(colOf(view.derivedAt)),
  })
}
