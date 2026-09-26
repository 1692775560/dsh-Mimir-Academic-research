/**
 * Evidence Graph layout (PRD §9/§33): the pure deterministic geometry layer
 * that maps the folded `EvidenceGraph` (+ researcher-declared Eureka records)
 * onto a temporal research worktree — research-line bands on the y axis, time
 * on the x axis, circular nodes, and routed SVG paths.
 *
 * Model B (the north-star reading): a research line is a band, a claim is a
 * branch rail whose head carries the terminal status, a declaration event is
 * a bead on the rail, cross-claim edges are merge curves, retractions are
 * revert loops, and Eureka declarations are emphasized markers on the line
 * header — never inferred, only declared (§107/§108). External sources (lit/
 * exp/run) surface as open-circle origins at the inflow start, not as a
 * parallel node soup; the full entity graph lives in the audit layer.
 *
 * Determinism contract: same input ⇒ byte-identical layout. No clocks, no
 * randomness, no DOM, no React, no locale — executable in Vitest (§33.1).
 * @module dsh-client-ui-mimir/client/evidence-graph-layout
 */

import type {
  EvidenceClaimHistory,
  EvidenceConflict,
  EvidenceGraphEdge,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'

/**
 * The minimal fold-product shape the layout consumes. `dsh-mimir/types` does
 * not re-export the composed `EvidenceGraph` itself, and the layout must not
 * import controller slices (§112) — so it takes the smallest structural
 * slice it needs: the timeline, the edges, and the conflicts.
 */
export interface EvidenceGraphLayoutInput {
  readonly timeline: readonly EvidenceTimelineGroup[]
  readonly edges: readonly EvidenceGraphEdge[]
  readonly conflicts: readonly EvidenceConflict[]
}

/** The retraction pseudo-rel a retract row carries (v1.1 §2.1). */
const RETRACT_REL = 'evidence.edge.retracted'

/**
 * Stable geometry constants for the research-map renderer (§35): one frozen
 * config, no scattered magic numbers in the renderer.
 */
export const EVIDENCE_GRAPH_LAYOUT_DEFAULTS = Object.freeze({
  /** Left gutter for the line band label + claim rail labels. */
  plotLeft: 248,
  /** Top padding hosting the time-axis labels. */
  topPad: 46,
  /** One research-line band's header row (line label + eureka markers). */
  bandHeader: 34,
  /** One claim rail's height. */
  laneHeight: 48,
  /** Trailing space for the claim head node + its status tag. */
  tailWidth: 132,
  /** Canvas floor width; the derived width only grows from here. */
  minWidth: 960,
  /** Minimum horizontal separation between beads on the time axis (§114). */
  minNodeGap: 30,
  /** Same-timestamp vertical stack step within one rail (§39). */
  nodeStackStep: 18,
  /** Maximum symmetric same-timestamp stack slots (0, ±1, ±2). */
  nodeStackLimit: 2,
  /** Radius hierarchy (§7.2). */
  nodeMinRadius: 6,
  nodeImportantRadius: 8,
  nodeMilestoneRadius: 10,
  nodeEurekaRadius: 8,
  /** Transparent interaction hit target radius (≥28px diameter). */
  nodeHitRadius: 14,
  /** Parallel edge bundling (§42). */
  parallelEdgeStep: 5,
  maxParallelEdgeOffset: 14,
  /** Edge hit target stroke width for pointer selection (§99). */
  edgeHitWidth: 18,
  /** Bottom padding. */
  bottomPad: 18,
})

/** The line palette size (bands cycle it; color continuity per line). */
export const LINE_HUES = 6

/** The canvas kinds of one positioned node. */
export type EvidenceNodeKind = 'event' | 'retract' | 'claim' | 'eureka' | 'source'

/** The relation color class of an event node (null on structure nodes). */
export type EvidenceRelClass = 'supports' | 'contradicts' | 'tests' | 'retract' | 'neutral'

/** One positioned circular node on the canvas. */
export interface EvidenceNodeLayout {
  /** Stable React key: the ledger event id, claim key, eureka id, or source key. */
  readonly id: string
  readonly kind: EvidenceNodeKind
  /** The raw relation (event/retract nodes); '' on structure nodes. */
  readonly rel: string
  readonly relClass: EvidenceRelClass | null
  readonly x: number
  readonly y: number
  readonly r: number
  /** The research-line hue index (structure color). */
  readonly hue: number
  /** The claim key whose rail carries the node (null on eureka/source nodes). */
  readonly claimKey: string | null
  readonly ts: string
  /** Tooltip / detail copy (plain text). */
  readonly label: string
  /** The ledger event id behind the node (provenance jump); null on heads. */
  readonly eventId: string | null
  readonly conflict: boolean
  readonly retracted: boolean
  /** The claim head's terminal status (claim nodes only). */
  readonly status: string | null
}

/** One routed link between nodes. */
export interface EvidenceLinkLayout {
  readonly kind: 'inflow' | 'external' | 'retract' | 'conflict'
  /** The routed SVG path data (§40 perimeter-trimmed endpoints). */
  readonly d: string
  readonly fromId: string
  readonly toId: string
  /** The source line hue (inflow color continuity). */
  readonly hue: number | null
}

/** One claim rail: the horizontal branch line + its head position. */
export interface EvidenceRailLayout {
  readonly claimKey: string
  readonly label: string
  readonly y: number
  readonly x1: number
  readonly x2: number
  readonly hue: number
  readonly headId: string
  readonly status: string | null
}

/** One research-line band: the y-axis swimlane grouping claim rails. */
export interface EvidenceBandLayout {
  readonly key: string
  readonly kind: 'idea' | 'project'
  readonly label: string | null
  readonly hue: number
  readonly y: number
  readonly height: number
  readonly claimKeys: readonly string[]
}

/** One date tick on the time axis. */
export interface EvidenceTickLayout {
  readonly x: number
  readonly label: string
}

/** The composed, positioned canvas geometry of one fold product. */
export interface EvidenceGraphLayout {
  readonly width: number
  readonly height: number
  readonly bands: readonly EvidenceBandLayout[]
  readonly rails: readonly EvidenceRailLayout[]
  readonly nodes: readonly EvidenceNodeLayout[]
  readonly links: readonly EvidenceLinkLayout[]
  readonly ticks: readonly EvidenceTickLayout[]
}

/** The Eureka shape the layout consumes (structurally the Remote view's row). */
export interface EvidenceEurekaPoint {
  readonly id: string
  readonly at: string
  readonly title: string
  readonly lineId: string | null
}

/** Layout options: researcher-declared Eureka markers (worktree alignment is P2). */
export interface EvidenceGraphLayoutOptions {
  readonly eurekaDeclarations?: readonly EvidenceEurekaPoint[] | undefined
}

/** An Eureka declaration attributed to no band renders on this trailing band. */
export const EUREKA_FALLBACK_BAND = 'eureka:unattributed'

interface Point {
  readonly x: number
  readonly y: number
}

/** Map one Eureka lineId onto the timeline-group key spelling. */
function bandKeyOfLine(lineId: string | null): string {
  if (lineId === null) return EUREKA_FALLBACK_BAND
  if (lineId.startsWith('project:')) return `project:${lineId.slice('project:'.length)}`
  return `idea:${lineId}`
}

/** The relation color class of one timeline entry. */
function relClassOf(entry: EvidenceTimelineEntry): EvidenceRelClass {
  if (entry.rel === RETRACT_REL) return 'retract'
  if (entry.rel === 'supports') return 'supports'
  if (entry.rel === 'contradicts') return 'contradicts'
  if (entry.rel === 'tests') return 'tests'
  return 'neutral'
}

/** Epoch milliseconds of an ISO timestamp, or null for invalid input (§36.1). */
function tsMs(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** Guard against NaN/Infinity reaching SVG attributes (§97). */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * The point on a circle's perimeter toward a target — edges terminate at the
 * node boundary, never its center (§40).
 */
function pointOnCircleToward(center: Point, radius: number, target: Point): Point {
  const dx = target.x - center.x
  const dy = target.y - center.y
  const distance = Math.hypot(dx, dy)
  if (distance === 0) return { x: center.x + radius, y: center.y }
  return { x: center.x + (dx / distance) * radius, y: center.y + (dy / distance) * radius }
}

/** CJK-safe truncation over a char budget (wide chars count double). */
function truncateLabel(text: string, maxWidth: number): string {
  let width = 0
  for (let index = 0; index < text.length; index += 1) {
    width += text.charCodeAt(index) > 0xff ? 2 : 1
    if (width > maxWidth) return `${text.slice(0, Math.max(0, index - 1))}…`
  }
  return text
}

const ACTOR_OF = (actor: EvidenceTimelineEntry['actor']): string =>
  actor.id !== '' ? actor.id : actor.kind

/** One flat bead draft before collision resolution (x/conflict/y mutate). */
interface BeadDraft {
  readonly id: string
  readonly claimKey: string
  readonly lane: number
  readonly entry: EvidenceTimelineEntry
  readonly relClass: EvidenceRelClass
  conflict: boolean
  x: number
  /** y stack slot within the rail for same-timestamp collisions. */
  y: number
}

/**
 * Lay the fold product out on the deterministic canvas (PRD §9/§111).
 * @param graph - the fold's `EvidenceGraph`.
 * @param options - optional Eureka declarations.
 * @returns the positioned geometry; an empty timeline yields an empty layout.
 */
export function deriveEvidenceGraphLayout(
  graph: EvidenceGraphLayoutInput,
  options: EvidenceGraphLayoutOptions = {},
): EvidenceGraphLayout {
  const eureka = options.eurekaDeclarations ?? []
  const lane = EVIDENCE_GRAPH_LAYOUT_DEFAULTS.laneHeight
  const bandHeader = EVIDENCE_GRAPH_LAYOUT_DEFAULTS.bandHeader
  const topPad = EVIDENCE_GRAPH_LAYOUT_DEFAULTS.topPad
  const plotLeft = EVIDENCE_GRAPH_LAYOUT_DEFAULTS.plotLeft
  const tailWidth = EVIDENCE_GRAPH_LAYOUT_DEFAULTS.tailWidth
  const minGap = EVIDENCE_GRAPH_LAYOUT_DEFAULTS.minNodeGap

  /* ── 1. Bands by first activity (top = earliest line), claims by first activity. */
  const ordered = [...graph.timeline]
    .map(group => ({ group, firstTs: firstTsOf(group) }))
    .sort((a, b) => a.firstTs.localeCompare(b.firstTs) || a.group.key.localeCompare(b.group.key))
  const claimsOf = (group: EvidenceTimelineGroup): readonly EvidenceClaimHistory[] =>
    [...group.claims].sort((a, b) =>
      firstEntryTs(a).localeCompare(firstEntryTs(b)) || a.claimKey.localeCompare(b.claimKey))

  /* ── 2. Temporal scale: valid timestamps of every bead + Eureka, §114. */
  const stamps = new Set<string>()
  for (const { group } of ordered) {
    for (const claim of group.claims) for (const entry of claim.history) stamps.add(entry.ts)
  }
  for (const point of eureka) stamps.add(point.at)
  const valid = [...stamps].map(ts => ({ ts, ms: tsMs(ts) })).filter(item => item.ms !== null)
  let minMs = valid.length > 0 ? Math.min(...valid.map(item => item.ms as number)) : 0
  let maxMs = valid.length > 0 ? Math.max(...valid.map(item => item.ms as number)) : 0
  const spanMs = maxMs - minMs

  const beadCount = ordered.reduce((sum, { group }) =>
    sum + group.claims.reduce((inner, claim) => inner + claim.history.length, 0), 0)
  const usable = Math.max(
    EVIDENCE_GRAPH_LAYOUT_DEFAULTS.minWidth,
    plotLeft + tailWidth + (beadCount + 1) * minGap,
  ) - plotLeft - tailWidth

  /** Proportional x for one timestamp (invalid → null; caller picks a lane fallback). */
  const idealXOf = (ts: string): number | null => {
    const ms = tsMs(ts)
    if (ms === null) return null
    if (spanMs === 0) return plotLeft + usable / 2
    return plotLeft + ((ms - minMs) / spanMs) * usable
  }

  /* ── 3. Bands, rails (y geometry). */
  const bands: EvidenceBandLayout[] = []
  const railYByClaim = new Map<string, number>()
  const railByClaim = new Map<string, EvidenceRailLayout>()
  const bandByClaim = new Map<string, EvidenceBandLayout>()
  const beadDrafts: BeadDraft[] = []
  let bandY = topPad
  ordered.forEach(({ group }, bandIndex) => {
    const claims = claimsOf(group)
    const bandTop = bandY
    const band: EvidenceBandLayout = {
      key: group.key,
      kind: group.kind,
      label: group.label,
      hue: bandIndex % LINE_HUES,
      y: bandTop,
      height: bandHeader + claims.length * lane,
      claimKeys: Object.freeze(claims.map(claim => claim.claimKey)),
    }
    bands.push(band)
    claims.forEach((claim, laneIndex) => {
      const laneY = bandTop + bandHeader + laneIndex * lane + lane / 2
      railYByClaim.set(claim.claimKey, laneY)
      bandByClaim.set(claim.claimKey, band)
      for (const entry of claim.history) {
        beadDrafts.push({
          id: entry.sourceEventId,
          claimKey: claim.claimKey,
          lane: laneY,
          entry,
          relClass: relClassOf(entry),
          conflict: false,
          x: finite(idealXOf(entry.ts) ?? plotLeft + usable / 2, plotLeft + usable / 2),
          y: 0,
        })
      }
      const rail: EvidenceRailLayout = {
        claimKey: claim.claimKey,
        label: claim.claimLabel,
        y: laneY,
        x1: 0, // patched after collision resolution
        x2: 0,
        hue: band.hue,
        headId: `head:${claim.claimKey}`,
        status: claim.status,
      }
      railByClaim.set(claim.claimKey, rail)
    })
    bandY += band.height
  })

  // Eureka-only fallback band (declarations with no matching line).
  const orphans = eureka.filter(point => !bands.some(band => band.key === bandKeyOfLine(point.lineId)))
  if (orphans.length > 0) {
    bands.push({
      key: EUREKA_FALLBACK_BAND,
      kind: 'project',
      label: null,
      hue: ordered.length % LINE_HUES,
      y: bandY,
      height: bandHeader,
      claimKeys: Object.freeze([]),
    })
    bandY += bandHeader
  }

  /* ── 4. Global collision resolution (§114/§115): monotonic x, shared columns
     for equal timestamps, per-rail y-stacking for same-column overlaps. */
  const conflictIds = new Set(
    graph.conflicts.flatMap(conflict => [conflict.supporting.sourceEventId, conflict.contradicting.sourceEventId]),
  )
  beadDrafts.sort((a, b) =>
    a.entry.ts.localeCompare(b.entry.ts) || a.claimKey.localeCompare(b.claimKey) || a.id.localeCompare(b.id))
  let lastTs = ''
  let lastX = plotLeft - minGap
  for (const bead of beadDrafts) {
    bead.conflict = conflictIds.has(bead.id)
    if (bead.entry.ts === lastTs) {
      bead.x = lastX
    } else {
      bead.x = Math.max(bead.x, lastX + minGap)
      lastX = bead.x
      lastTs = bead.entry.ts
    }
  }
  // Per-rail same-column stacking: symmetric slots 0, −1, +1, −2, +2, capped (§39).
  const slotByKey = new Map<string, number>()
  for (const bead of beadDrafts) {
    const key = `${bead.claimKey}|${bead.x}`
    const slot = slotByKey.get(key) ?? 0
    slotByKey.set(key, slot + 1)
    const direction = slot === 0 ? 0 : (slot % 2 === 1 ? -1 : 1)
    const depth = Math.min(Math.ceil(slot / 2), EVIDENCE_GRAPH_LAYOUT_DEFAULTS.nodeStackLimit)
    bead.y = (railYByClaim.get(bead.claimKey) ?? 0) + direction * depth * EVIDENCE_GRAPH_LAYOUT_DEFAULTS.nodeStackStep
  }
  // Patch rails to their first/last bead x.
  for (const bead of beadDrafts) {
    const rail = railByClaim.get(bead.claimKey)
    if (rail === undefined) continue
    if (rail.x1 === 0 || bead.x < rail.x1) {
      const next = { ...rail, x1: bead.x }
      railByClaim.set(bead.claimKey, next)
    }
    if (bead.x > rail.x2) {
      railByClaim.set(bead.claimKey, { ...railByClaim.get(bead.claimKey) as EvidenceRailLayout, x2: bead.x })
    }
  }

  /* ── 5. Nodes. */
  const nodes: EvidenceNodeLayout[] = []
  const nodeByEvent = new Map<string, EvidenceNodeLayout>()
  const edgeBySourceEvent = new Map(graph.edges.map(edge => [edge.sourceEventId, edge] as const))
  const edgeByRetractEvent = new Map(
    graph.edges.filter(edge => edge.retractEventId !== null).map(edge => [edge.retractEventId as string, edge] as const),
  )
  for (const bead of beadDrafts) {
    const band = bandByClaim.get(bead.claimKey)
    const isRetract = bead.entry.rel === RETRACT_REL
    const r = isRetract
      ? EVIDENCE_GRAPH_LAYOUT_DEFAULTS.nodeMinRadius
      : bead.conflict
        ? EVIDENCE_GRAPH_LAYOUT_DEFAULTS.nodeImportantRadius
        : EVIDENCE_GRAPH_LAYOUT_DEFAULTS.nodeMinRadius
    const node: EvidenceNodeLayout = Object.freeze({
      id: bead.id,
      kind: isRetract ? 'retract' : 'event',
      rel: bead.entry.rel,
      relClass: bead.relClass,
      x: bead.x,
      y: bead.y,
      r,
      hue: band?.hue ?? 0,
      claimKey: bead.claimKey,
      ts: bead.entry.ts,
      label: `${bead.entry.ts.slice(0, 16)} · ${bead.entry.rel} · ${ACTOR_OF(bead.entry.actor)}${bead.entry.note !== null ? ` · ${bead.entry.note}` : ''}`,
      eventId: bead.id,
      conflict: bead.conflict,
      retracted: bead.entry.retracted,
      status: null,
    })
    nodes.push(node)
    nodeByEvent.set(node.id, node)
  }

  // Claim heads (branch tips with status).
  for (const [claimKey, rail] of railByClaim) {
    if (rail.x1 === 0 && rail.x2 === 0) continue
    const headX = rail.x2 + 18
    nodes.push(Object.freeze({
      id: rail.headId,
      kind: 'claim',
      rel: '',
      relClass: null,
      x: headX,
      y: rail.y,
      r: EVIDENCE_GRAPH_LAYOUT_DEFAULTS.nodeMilestoneRadius,
      hue: rail.hue,
      claimKey,
      ts: '',
      label: rail.label,
      eventId: null,
      conflict: false,
      retracted: false,
      status: rail.status,
    }))
  }

  // Eureka markers on the band header rows (strongest declared hierarchy, §79).
  const headerYOf = (bandKey: string): number => {
    const band = bands.find(item => item.key === bandKey)
    const y = (band ?? bands[bands.length - 1])?.y ?? topPad
    return y + bandHeader / 2 + 2
  }
  for (const point of eureka) {
    const bandKey = bandKeyOfLine(point.lineId)
    const band = bands.find(item => item.key === bandKey)
    nodes.push(Object.freeze({
      id: `eureka:${point.id}`,
      kind: 'eureka',
      rel: '',
      relClass: null,
      x: finite(idealXOf(point.at) ?? plotLeft + usable / 2, plotLeft + usable / 2),
      y: headerYOf(bandKey),
      r: EVIDENCE_GRAPH_LAYOUT_DEFAULTS.nodeEurekaRadius,
      hue: band?.hue ?? 0,
      claimKey: null,
      ts: point.at,
      label: point.title,
      eventId: null,
      conflict: false,
      retracted: false,
      status: null,
    }))
  }

  /* ── 6. Routed links (§40 perimeter, §42 parallel bundling). */
  const links: EvidenceLinkLayout[] = []
  const parallelOffset = new Map<string, number>()
  for (const node of nodes) {
    if (node.kind !== 'event') continue
    const edge = edgeBySourceEvent.get(node.id)
    if (edge === undefined) continue
    const srcRail = railByClaim.get(edge.src)
    const center: Point = { x: node.x, y: node.y }
    // Cross-claim inflow: a merge curve from the source rail onto this bead.
    if (srcRail !== undefined && srcRail.claimKey !== node.claimKey && node.x - 40 >= srcRail.x1 - 4 && srcRail.y !== node.y) {
      const x0 = Math.max(srcRail.x1, node.x - 40)
      const start: Point = { x: x0, y: srcRail.y }
      const end = pointOnCircleToward(center, node.r + 2, start)
      const midX = (x0 + end.x) / 2
      const off = parallelSlot(parallelOffset, `inflow:${srcRail.claimKey}|${node.id}`, 0)
      links.push(Object.freeze({
        kind: 'inflow',
        d: `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y + off}, ${end.x} ${end.y}`,
        fromId: srcRail.headId,
        toId: node.id,
        hue: srcRail.hue,
      }))
      continue
    }
    // External inflow: a non-claim source drops in from above with an open circle.
    if (srcRail === undefined) {
      const origin: Point = { x: node.x - 22, y: node.y - 26 }
      const end = pointOnCircleToward(center, node.r + 2, origin)
      nodes.push(Object.freeze({
        id: `source:${node.id}`,
        kind: 'source',
        rel: '',
        relClass: null,
        x: origin.x,
        y: origin.y,
        r: 4,
        hue: node.hue,
        claimKey: null,
        ts: edge.ts,
        label: edge.src,
        eventId: null,
        conflict: false,
        retracted: false,
        status: null,
      }))
      links.push(Object.freeze({
        kind: 'external',
        d: `M ${origin.x} ${origin.y} C ${node.x - 16} ${node.y - 12}, ${node.x - 8} ${node.y - 8}, ${end.x} ${end.y}`,
        fromId: `source:${node.id}`,
        toId: node.id,
        hue: null,
      }))
    }
  }
  // Retract loops back onto the retracted declaration bead.
  for (const node of nodes) {
    if (node.kind !== 'retract') continue
    const edge = edgeByRetractEvent.get(node.id)
    const origin = edge === undefined ? undefined : nodeByEvent.get(edge.id)
    if (origin === undefined) continue
    const archY = Math.min(node.y, origin.y) - 30
    const start = pointOnCircleToward({ x: node.x, y: node.y }, node.r + 2, { x: origin.x, y: origin.y })
    const end = pointOnCircleToward({ x: origin.x, y: origin.y }, origin.r + 2, { x: node.x, y: node.y })
    links.push(Object.freeze({
      kind: 'retract',
      d: `M ${start.x} ${start.y} C ${node.x + 16} ${archY}, ${origin.x - 16} ${archY}, ${end.x} ${end.y}`,
      fromId: node.id,
      toId: origin.id,
      hue: null,
    }))
  }
  // Conflict arcs between the active pair.
  for (const conflict of graph.conflicts) {
    const left = nodeByEvent.get(conflict.supporting.sourceEventId)
    const right = nodeByEvent.get(conflict.contradicting.sourceEventId)
    if (left === undefined || right === undefined) continue
    const [first, second] = left.x <= right.x ? [left, right] : [right, left]
    const archY = Math.min(first.y, second.y) - 26
    links.push(Object.freeze({
      kind: 'conflict',
      d: `M ${first.x} ${first.y - first.r - 3} C ${first.x + 12} ${archY}, ${second.x - 12} ${archY}, ${second.x} ${second.y - second.r - 3}`,
      fromId: first.id,
      toId: second.id,
      hue: null,
    }))
  }
  links.sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.fromId.localeCompare(b.fromId) || a.toId.localeCompare(b.toId))

  /* ── 7. Ticks at the first bead of every date. */
  const ticks: EvidenceTickLayout[] = []
  let previousDate = ''
  for (const bead of beadDrafts) {
    const date = bead.entry.ts.slice(0, 10)
    if (date === previousDate) continue
    previousDate = date
    ticks.push(Object.freeze({ x: bead.x, label: date }))
  }

  /* ── 8. Extent. */
  let maxRailX: number = plotLeft
  for (const rail of railByClaim.values()) if (rail.x2 > maxRailX) maxRailX = rail.x2
  let maxNodeX: number = maxRailX
  for (const node of nodes) if (node.x + node.r > maxNodeX) maxNodeX = node.x + node.r
  const width = Math.max(maxNodeX + tailWidth, EVIDENCE_GRAPH_LAYOUT_DEFAULTS.minWidth)
  const height = bandY + EVIDENCE_GRAPH_LAYOUT_DEFAULTS.bottomPad

  return Object.freeze({
    width,
    height,
    bands: Object.freeze(bands.map(band => Object.freeze({ ...band, claimKeys: Object.freeze(band.claimKeys) }))),
    rails: Object.freeze([...railByClaim.values()]
      .sort((a, b) => a.y - b.y || a.claimKey.localeCompare(b.claimKey))
      .map(rail => Object.freeze(rail))),
    nodes: Object.freeze(nodes),
    links: Object.freeze(links),
    ticks: Object.freeze(ticks),
  })
}

/** Deterministic symmetric offsets for parallel edges between one pair (§42). */
function parallelSlot(registry: Map<string, number>, key: string, step: number): number {
  const index = registry.get(key) ?? 0
  registry.set(key, index + 1)
  if (step <= 0) return 0
  const depth = Math.min(Math.floor(index / 2), 2)
  const direction = index % 2 === 0 ? 1 : -1
  return direction * depth * step
}

function firstEntryTs(claim: EvidenceClaimHistory): string {
  return claim.history[0]?.ts ?? ''
}

function firstTsOf(group: EvidenceTimelineGroup): string {
  let earliest = ''
  for (const claim of group.claims) {
    const ts = firstEntryTs(claim)
    if (earliest === '' || ts < earliest) earliest = ts
  }
  return earliest
}

/** CJK-safe truncation over a char budget (wide chars count double). */
export function clipLabel(text: string, maxWidth: number): string {
  return truncateLabel(text, maxWidth)
}
