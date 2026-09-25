/**
 * Evidence lane-graph view-model (v3, horizontal workflow diagram): turns
 * the fold's claim-centric timeline into a classic git-workflow layout —
 * one horizontal rail per claim with a colored claim tab at the left, time
 * flowing left → right, semantic nodes on the rails, S-curves for evidence
 * flowing in from other claims, a dashed loop for retractions, and a status
 * milestone tag at each claim's head. Pure glue over the fold product: no
 * layout library, no DOM, deterministic for a given input (the same
 * re-derivable discipline as the v1 card helpers).
 *
 * Reading order (the cognitive-map's structure-first reading): rails top →
 * bottom by first activity, time left → right within a rail; the diagram
 * carries structure only — details live behind each node (progressive
 * disclosure) and in the v1 list.
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

/** The stable hue palette size (claim tabs cycle it, like branch labels). */
export const LANE_HUES = 6

/** The visual kind of one lane node. */
export type LaneDotKind = 'edge' | 'retract'

/**
 * The rendered node shape — shape carries the semantics first, color backs
 * it up: filled disc (supports), disc with a bold × (contradicts), bullseye
 * (检验 tests), small hollow disc (other relations), diamond (retraction).
 */
export type LaneDotShape = 'dot' | 'cross' | 'bullseye' | 'hollow' | 'diamond'

/** The CSS color class of one node's relation. */
export type LaneDotRelClass = 'supports' | 'contradicts' | 'tests' | 'retract' | 'neutral'

/** One declaration/retraction node on the workflow grid. */
export interface LaneDot {
  /** The ledger event id — stable React key and provenance anchor. */
  readonly id: string
  /** The claim rail index (0 = top rail). */
  readonly lane: number
  /** The time column (chronological index across the whole group). */
  readonly col: number
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
  /** First node of its calendar date (the axis prints the day label here). */
  readonly dateFirst: boolean
  readonly note: string | null
}

/** One wire of the diagram: a cross-claim inflow or a retraction loop. */
export interface LaneWire {
  readonly kind: 'cross' | 'retract'
  readonly fromLane: number
  readonly toLane: number
  readonly fromCol: number
  readonly toCol: number
}

/** One claim rail's colored tab (structure identity + state). */
export interface LaneHeader {
  readonly claimKey: string
  readonly label: string
  readonly status: string | null
  readonly supports: number
  readonly contradicts: number
  readonly conflict: boolean
  readonly hue: number
  /** The rail's last activity column — where the status milestone tag goes. */
  readonly lastCol: number
}

/** The horizontal extent of one rail (first..last node column). */
export interface LaneSpan {
  readonly lane: number
  readonly firstCol: number
  readonly lastCol: number
}

/** One research line's workflow layout (the diagram of one timeline group). */
export interface LaneGroupGraph {
  readonly key: string
  readonly kind: 'idea' | 'project'
  readonly label: string | null
  readonly laneCount: number
  readonly colCount: number
  readonly headers: readonly LaneHeader[]
  readonly dots: readonly LaneDot[]
  readonly wires: readonly LaneWire[]
  readonly spans: readonly LaneSpan[]
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

/** The CSS color class of one node (retract rows own their class). */
function relClassOf(kind: LaneDotKind, rel: string): LaneDotRelClass {
  if (kind === 'retract') return 'retract'
  if (rel === 'supports') return 'supports'
  if (rel === 'contradicts') return 'contradicts'
  if (rel === 'tests') return 'tests'
  return 'neutral'
}

/** The node shape of one timeline entry (shape = semantics at a glance). */
function shapeOf(kind: LaneDotKind, rel: string, retracted: boolean): LaneDotShape {
  if (kind === 'retract') return 'diamond'
  if (retracted) return 'hollow'
  if (rel === 'supports') return 'dot'
  if (rel === 'contradicts') return 'cross'
  if (rel === 'tests') return 'bullseye'
  return 'hollow'
}

/**
 * Build the workflow layouts for every timeline group, newest-active group
 * first (the fold's own order). `edges` resolve timeline entries back to
 * their src/dst (the timeline entry carries neither), and `conflicts` mark
 * the active pair nodes.
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
  // Rails ordered by first activity (oldest claim on the top rail), claimKey
  // as the deterministic tiebreak — same input, same layout, always.
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

  // Pass 1: nodes (columns = global chronological order across rails).
  const dots: LaneDot[] = []
  const nodeByDotId = new Map<string, { readonly lane: number; readonly col: number }>()
  let previousDate = ''
  items.forEach((item, col) => {
    const kind: LaneDotKind = item.entry.rel === RETRACT_REL ? 'retract' : 'edge'
    const dateLabel = item.entry.ts.slice(0, 10)
    const dot: LaneDot = Object.freeze({
      id: item.entry.sourceEventId,
      lane: item.lane,
      col,
      rel: item.entry.rel,
      kind,
      shape: shapeOf(kind, item.entry.rel, item.entry.retracted),
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
    nodeByDotId.set(dot.id, { lane: dot.lane, col: dot.col })
  })

  // Pass 2: wires. Cross — the declared edge's src is another claim rail in
  // this group (evidence flowing in, drawn at the event's own time column).
  // Retract — the retracted edge's earliest declaration node is in this
  // group (the dashed loop back; otherwise the flat list still tells it).
  const wires: LaneWire[] = []
  for (const dot of dots) {
    if (dot.kind === 'edge') {
      const edge = edgeBySourceEvent.get(dot.id)
      const srcLane = edge === undefined ? undefined : laneByClaimKey.get(edge.src)
      if (srcLane !== undefined && srcLane !== dot.lane) {
        wires.push(Object.freeze({ kind: 'cross', fromLane: srcLane, toLane: dot.lane, fromCol: dot.col, toCol: dot.col }))
      }
    } else {
      const edge = edgeByRetractEvent.get(dot.id)
      const origin = edge === undefined ? undefined : nodeByDotId.get(edge.id)
      if (origin !== undefined) {
        wires.push(Object.freeze({
          kind: 'retract',
          fromLane: origin.lane,
          toLane: dot.lane,
          fromCol: origin.col,
          toCol: dot.col,
        }))
      }
    }
  }
  wires.sort((left, right) =>
    left.fromCol - right.fromCol || left.toCol - right.toCol
      || left.fromLane - right.fromLane || left.kind.localeCompare(right.kind),
  )

  // Rail extents: each rail runs from its first to its last node column.
  const spanByLane = new Map<number, { firstCol: number; lastCol: number }>()
  for (const dot of dots) {
    const span = spanByLane.get(dot.lane)
    if (span === undefined) {
      spanByLane.set(dot.lane, { firstCol: dot.col, lastCol: dot.col })
    } else if (dot.col > span.lastCol) {
      span.lastCol = dot.col
    }
  }
  const spans: LaneSpan[] = [...spanByLane.entries()]
    .map(([lane, span]) => Object.freeze({ lane, firstCol: span.firstCol, lastCol: span.lastCol }))
    .sort((left, right) => left.lane - right.lane)

  const headers: LaneHeader[] = laneClaims.map((claim, index) => {
    const lane = index
    const span = spans.find(span => span.lane === lane)
    return Object.freeze({
      claimKey: claim.claimKey,
      label: claim.claimLabel,
      status: claim.status,
      supports: claim.supportsCount,
      contradicts: claim.contradictsCount,
      conflict: claim.hasConflict,
      hue: index % LANE_HUES,
      lastCol: span?.lastCol ?? 0,
    })
  })

  return Object.freeze({
    key: group.key,
    kind: group.kind,
    label: group.label,
    laneCount: laneClaims.length,
    colCount: dots.length,
    headers: Object.freeze(headers),
    dots: Object.freeze(dots),
    wires: Object.freeze(wires),
    spans: Object.freeze(spans),
  })
}
