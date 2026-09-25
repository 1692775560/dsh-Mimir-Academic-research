/**
 * Evidence lane-graph view-model (v2): turns the fold's claim-centric
 * timeline into a git-worktree-style lane layout — one lane per claim, dots
 * for declarations/retractions, wires for cross-claim evidence and retract
 * loops — so the ledger reads like a commit graph at a glance while every
 * dot keeps its provenance jump. Pure glue over the fold product: no
 * layout library, no DOM, deterministic for a given input (the same
 * re-derivable discipline as the v1 card helpers).
 *
 * Lane semantics (borrowing the cognitive-map's structure-first reading):
 * a lane is one claim's accumulation story; a curve leaving another lane is
 * evidence flowing in from elsewhere; a diamond is the human retraction
 * riding back on the lane. Color belongs to STRUCTURE (the lane), actor
 * identity rides a stable hue on the row badge.
 * @module dsh-client-ui-mimir/client/evidence-lane-graph
 */

import type {
  EvidenceConflict,
  EvidenceGraphEdge,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'

/** The retraction pseudo-rel a retract row carries (v1.1 §2.1). */
const RETRACT_REL = 'evidence.edge.retracted'

/** The stable hue palette size (lane fills and actor badge tints cycle it). */
export const LANE_HUES = 6

/** The visual kind of one lane dot. */
export type LaneDotKind = 'edge' | 'retract'

/** The rendered dot shape: filled, hollow (retracted), diamond (retraction). */
export type LaneDotShape = 'dot' | 'hollow' | 'diamond'

/** The CSS color class of one dot's relation. */
export type LaneDotRelClass = 'supports' | 'contradicts' | 'retract' | 'neutral'

/** One declaration/retraction dot on the lane grid. */
export interface LaneDot {
  /** The ledger event id — stable React key and provenance anchor. */
  readonly id: string
  readonly lane: number
  readonly row: number
  /** The raw relation (or the retraction action for retract rows). */
  readonly rel: string
  readonly kind: LaneDotKind
  readonly shape: LaneDotShape
  /** Struck-through semantics: a superseded/retracted edge or a retract row. */
  readonly retracted: boolean
  readonly relClass: LaneDotRelClass
  /** Active conflict pair membership (red ring in the view). */
  readonly conflict: boolean
  readonly actorHue: number
  readonly actorLabel: string
  readonly ts: string
  readonly dateLabel: string
  readonly timeLabel: string
  /** First dot of its calendar date (the view prints the day chip here). */
  readonly dateFirst: boolean
  readonly note: string | null
}

/** One wire of the lane diagram: a cross-claim edge or a retract loop. */
export interface LaneWire {
  readonly kind: 'cross' | 'retract'
  readonly fromLane: number
  readonly toLane: number
  readonly fromRow: number
  readonly toRow: number
}

/** One claim lane's header chip (color = structure, badges = state). */
export interface LaneHeader {
  readonly claimKey: string
  readonly label: string
  readonly status: string | null
  readonly supports: number
  readonly contradicts: number
  readonly conflict: boolean
  readonly hue: number
}

/** The vertical extent of one lane's spine (first..last dot row). */
export interface LaneSpan {
  readonly lane: number
  readonly firstRow: number
  readonly lastRow: number
}

/** One research line's lane layout (the graph rendering of one timeline group). */
export interface LaneGroupGraph {
  readonly key: string
  readonly kind: 'idea' | 'project'
  readonly label: string | null
  readonly laneCount: number
  readonly headers: readonly LaneHeader[]
  readonly dots: readonly LaneDot[]
  readonly wires: readonly LaneWire[]
  readonly spans: readonly LaneSpan[]
  readonly rowCount: number
}

/**
 * Stable hue index for one actor: djb2 over `kind:id`, so the same actor
 * keeps the same badge tint across rows, groups, and sessions without a
 * registry.
 */
export function actorHueOf(kind: string, id: string): number {
  let hash = 5381
  const seed = `${kind}:${id}`
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) | 0
  }
  return Math.abs(hash) % LANE_HUES
}

/** The CSS color class of one dot (retract rows own their class). */
function relClassOf(kind: LaneDotKind, rel: string): LaneDotRelClass {
  if (kind === 'retract') return 'retract'
  if (rel === 'supports') return 'supports'
  if (rel === 'contradicts') return 'contradicts'
  return 'neutral'
}

/** The dot shape of one timeline entry. */
function shapeOf(kind: LaneDotKind, retracted: boolean): LaneDotShape {
  if (kind === 'retract') return 'diamond'
  return retracted ? 'hollow' : 'dot'
}

/**
 * Build the lane layouts for every timeline group, newest-active group
 * first (the fold's own order). `edges` resolve timeline entries back to
 * their src/dst (the timeline entry carries neither), and `conflicts` mark
 * the active pair dots.
 */
export function buildLaneGroups(
  timeline: readonly EvidenceTimelineGroup[],
  edges: readonly EvidenceGraphEdge[],
  conflicts: readonly EvidenceConflict[],
): readonly LaneGroupGraph[] {
  const edgeBySourceEvent = new Map(edges.map(edge => [edge.sourceEventId, edge] as const))
  const edgeByRetractEvent = new Map(
    edges
      .filter(edge => edge.retractEventId !== null)
      .map(edge => [edge.retractEventId as string, edge] as const),
  )
  const conflictEdgeIds = new Set(
    conflicts.flatMap(conflict => [conflict.supporting.sourceEventId, conflict.contradicting.sourceEventId]),
  )
  return timeline.map(group =>
    buildGroup(group, edgeBySourceEvent, edgeByRetractEvent, conflictEdgeIds),
  )
}

function buildGroup(
  group: EvidenceTimelineGroup,
  edgeBySourceEvent: Map<string, EvidenceGraphEdge>,
  edgeByRetractEvent: Map<string, EvidenceGraphEdge>,
  conflictEdgeIds: Set<string>,
): LaneGroupGraph {
  // Lanes ordered by first activity (oldest claim leftmost), claimKey as the
  // deterministic tiebreak — the same input always yields the same layout.
  const laneClaims = [...group.claims].sort((left, right) => {
    const leftTs = left.history[0]?.ts ?? ''
    const rightTs = right.history[0]?.ts ?? ''
    return leftTs.localeCompare(rightTs) || left.claimKey.localeCompare(right.claimKey)
  })
  const laneByClaimKey = new Map(laneClaims.map((claim, index) => [claim.claimKey, index] as const))

  interface EntryItem {
    readonly claimKey: string
    readonly lane: number
    readonly entry: EvidenceTimelineEntry
  }
  const items: EntryItem[] = laneClaims.flatMap(claim =>
    claim.history.map(entry => ({ claimKey: claim.claimKey, lane: laneByClaimKey.get(claim.claimKey) ?? 0, entry })),
  )
  items.sort((left, right) =>
    left.entry.ts.localeCompare(right.entry.ts) || left.entry.sourceEventId.localeCompare(right.entry.sourceEventId),
  )

  const headers: LaneHeader[] = laneClaims.map((claim, index) => Object.freeze({
    claimKey: claim.claimKey,
    label: claim.claimLabel,
    status: claim.status,
    supports: claim.supportsCount,
    contradicts: claim.contradictsCount,
    conflict: claim.hasConflict,
    hue: index % LANE_HUES,
  }))

  // Pass 1: dots (row order = global chronological order across lanes).
  const dots: LaneDot[] = []
  const rowByDotId = new Map<string, { readonly lane: number; readonly row: number }>()
  let previousDate = ''
  items.forEach((item, row) => {
    const kind: LaneDotKind = item.entry.rel === RETRACT_REL ? 'retract' : 'edge'
    const dateLabel = item.entry.ts.slice(0, 10)
    const dot: LaneDot = Object.freeze({
      id: item.entry.sourceEventId,
      lane: item.lane,
      row,
      rel: item.entry.rel,
      kind,
      shape: shapeOf(kind, item.entry.retracted),
      retracted: item.entry.retracted || kind === 'retract',
      relClass: relClassOf(kind, item.entry.rel),
      conflict: conflictEdgeIds.has(item.entry.sourceEventId),
      actorHue: actorHueOf(item.entry.actor.kind, item.entry.actor.id),
      actorLabel: item.entry.actor.id !== '' ? item.entry.actor.id : item.entry.actor.kind,
      ts: item.entry.ts,
      dateLabel,
      timeLabel: item.entry.ts.slice(11, 16),
      dateFirst: dateLabel !== previousDate,
      note: item.entry.note,
    })
    previousDate = dateLabel
    dots.push(dot)
    rowByDotId.set(dot.id, { lane: dot.lane, row: dot.row })
  })

  // Pass 2: wires. Cross — the declared edge's src is another claim lane in
  // this group (evidence flowing in). Retract — the retracted edge's earliest
  // declaration dot is in this group (the loop back; when the declaration
  // lives in another group the wire is omitted, the flat list still tells it).
  const wires: LaneWire[] = []
  for (const dot of dots) {
    if (dot.kind === 'edge') {
      const edge = edgeBySourceEvent.get(dot.id)
      const srcLane = edge === undefined ? undefined : laneByClaimKey.get(edge.src)
      if (srcLane !== undefined && srcLane !== dot.lane) {
        wires.push(Object.freeze({ kind: 'cross', fromLane: srcLane, toLane: dot.lane, fromRow: dot.row, toRow: dot.row }))
      }
    } else {
      const edge = edgeByRetractEvent.get(dot.id)
      const origin = edge === undefined ? undefined : rowByDotId.get(edge.id)
      if (origin !== undefined) {
        wires.push(Object.freeze({
          kind: 'retract',
          fromLane: origin.lane,
          toLane: dot.lane,
          fromRow: origin.row,
          toRow: dot.row,
        }))
      }
    }
  }
  wires.sort((left, right) =>
    left.fromRow - right.fromRow || left.toRow - right.toRow
      || left.fromLane - right.fromLane || left.kind.localeCompare(right.kind),
  )

  // Spans: each lane's spine runs from its first to its last dot.
  const spanByLane = new Map<number, { firstRow: number; lastRow: number }>()
  for (const dot of dots) {
    const span = spanByLane.get(dot.lane)
    if (span === undefined) {
      spanByLane.set(dot.lane, { firstRow: dot.row, lastRow: dot.row })
    } else if (dot.row > span.lastRow) {
      span.lastRow = dot.row
    }
  }
  const spans: LaneSpan[] = [...spanByLane.entries()]
    .map(([lane, span]) => Object.freeze({ lane, firstRow: span.firstRow, lastRow: span.lastRow }))
    .sort((left, right) => left.lane - right.lane)

  return Object.freeze({
    key: group.key,
    kind: group.kind,
    label: group.label,
    laneCount: laneClaims.length,
    headers: Object.freeze(headers),
    dots: Object.freeze(dots),
    wires: Object.freeze(wires),
    spans: Object.freeze(spans),
    rowCount: dots.length,
  })
}
