/**
 * Evidence graph (v1): the L1 pure fold over the append-only ledger that
 * derives the nodes, edges, conflicts, timeline projection, and stats of the
 * research's evidence graph. Sibling of `cognitive-map.ts` in the fold
 * family — it imports ONLY leaf modules (`./time.ts`, `./evidence-identity.ts`,
 * `./vocabulary.ts`) and never a sibling fold, so the six-folds-don't-import-
 * each-other discipline survives a seventh fold.
 *
 * Layering (v1.0 §2.1): L0 facts are the `events` rows themselves — the only
 * new actions are `evidence.edge.added` and `evidence.edge.retracted`, both
 * best-effort emissions over the existing `emitEvent` contract. Everything
 * this module produces is L1: a pure fold product that exists only in Remote
 * responses and UI memory. It is NEVER persisted as fact, and there is no L2
 * cache in v1 — the whole fold reruns per read, same cost model as
 * `generateBrief`.
 *
 * Resolution rules (v1.1 §2.1):
 *  - **Dedup**: declarations sharing a `dedupKey` merge into one edge; the
 *    earliest event id survives, the rest count in `stats.duplicateEdges`.
 *  - **Retraction**: last-declaration-wins per dedupKey. A retracted edge is
 *    KEPT in `edges[]` (marked `retracted` + `retractedAt/retractedBy`), can
 *    be re-asserted back to active, and a retraction pointing at a dedupKey
 *    that never appeared counts in `stats.retractOrphans` (disclosed, never
 *    silent — I2). The fold resolves state; it does NOT enforce permissions
 *    (the service boundary owns authorization).
 *  - **Alias merge**: `keys` aliases (arxiv/doi/url/titleFp) and the fold-
 *    derived title fingerprints of `literature.paper.imported` unify
 *    literature nodes through a union-find whose root is always the
 *    lexicographically smallest key, so the canonical node key is
 *    deterministic regardless of event order. Merge counts disclose in
 *    `stats.aliasMerges`.
 *  - **Conflicts**: only the ACTIVE口径 pairs a `supports` edge against a
 *    `contradicts` edge onto the same claim node — a retracted assertion
 *    never triggers a conflict.
 *  - **Timeline**: edges belonging to a claim (`refs.claimId`) project into
 *    per-claim histories grouped by the claim's most specific attribution
 *    (ideaId wins over the project fallback, decided AFTER aggregating the
 *    whole claim so a late-added ideaId does not split a claim across
 *    groups — v1.1 risk note 1). Edges without a claimId (cites/extends/
 *    uses/…) stay out of the timeline and live in the flat list only.
 *
 * Brief access gate (v1.1 decision 4, written down to prevent drift): the
 * ONLY legal path for graph signals into the cognitive brief is — compose
 * layer calls `deriveEvidenceGraph` itself and passes a read-only projection
 * as an EXPLICIT argument to `deriveBrief` (no fold-to-fold import), AND
 * `CBE_DERIVATION_VERSION` bumps 2→3, AND the registry opens a dedicated
 * gate for the signal (same change process as a `LINE_WEIGHTS` change).
 * None of that wiring exists in this round; this module stays read-side.
 * @module dsh-mimir/src/evidence-graph
 */

import type { EventRecord, LedgerActor, LedgerJsonValue } from './types.ts'
import { lineOf } from './vocabulary.ts'
import { orderedEvents, sliceEvents, tsToMs } from './time.ts'
import {
  ALIAS_MAX_CHARS,
  dedupKeyOf,
  evidenceScopeOf,
  isDedupKey,
  isTitleFingerprint,
  isValidNodeKey,
  normalizeDoi,
  normalizeUrl,
  titleFingerprint,
} from './evidence-identity.ts'

/** The append-only declaration of one evidence edge (v1.0 §2.2 schema). */
export const EVIDENCE_EDGE_ADDED_ACTION = 'evidence.edge.added'
/** The append-only retraction of one evidence edge (v1.1 §2.1 schema). */
export const EVIDENCE_EDGE_RETRACTED_ACTION = 'evidence.edge.retracted'

/**
 * The evidence graph's derivation version (I5 sibling): bump — and only
 * bump — when a parameter that changes derived results moves (the title
 * fingerprint pipeline, the stopword table, the edge rules, the timeline
 * grouping). The view discloses it so a changed number is never silently
 * reinterpreted as a changed history.
 */
export const EVIDENCE_GRAPH_DERIVATION_VERSION = 1

/** The relation enum carried by `evidence.edge.added` (v1.0 §1.3). */
export const EVIDENCE_EDGE_RELS = [
  'supports', 'contradicts', 'tests', 'cites', 'extends', 'uses', 'retrieved-via',
] as const

/** One relation of an explicitly declared edge. */
export type EvidenceEdgeRel = typeof EVIDENCE_EDGE_RELS[number]

/** Every relation an edge can carry: declared ones plus the derived ones. */
export type EvidenceGraphRel = EvidenceEdgeRel | 'imports' | 'yields' | 'pinned-as' | 'narrates'

/** Whether one string is a member of the declared-relation enum. */
export function isEvidenceEdgeRel(value: string): value is EvidenceEdgeRel {
  return (EVIDENCE_EDGE_RELS as readonly string[]).includes(value)
}

/** The fold's window: ISO-8601 bounds (`until` exclusive) + project scope; null opens the bound. */
export interface EvidenceGraphWindow {
  readonly since: string | null
  readonly until: string | null
  readonly projectId: string | null
}

/** The wiki tables the fold reads for labels and claim statuses (structural twin of the CBE snapshot). */
export interface EvidenceWikiSnapshot {
  readonly ideas: readonly { readonly id: string; readonly title: string }[]
  readonly claims: readonly { readonly id: string; readonly text: string; readonly status: string }[]
  readonly projects: readonly { readonly id: string; readonly title: string }[]
}

/** Normalized alias keys riding one declaration (v1.0 §2.2 `keys`). */
export interface EvidenceAliasKeys {
  readonly arxiv?: string | undefined
  readonly doi?: string | undefined
  readonly url?: string | undefined
  readonly titleFp?: string | undefined
}

/** One derived evidence node (L1: re-derivable, never a fact). */
export interface EvidenceGraphNode {
  /** The canonical (alias-resolved) node key, `kind:value`. */
  readonly key: string
  /** The key's kind prefix (`claim`, `lit`, `idea`, `proj`, …). */
  readonly kind: string
  /** First resolved display label, or null. */
  readonly label: string | null
  readonly firstSeen: string
  readonly lastSeen: string
  /** The alias keys that unified into this node (sorted; excludes the key itself). */
  readonly aliases: readonly string[]
  /** The earliest event backing this node (the provenance anchor). */
  readonly sourceEventId: string
}

/** One derived evidence edge — the evidence's own provenance line. */
export interface EvidenceGraphEdge {
  /** The earliest declaration's event id (the edge's identity anchor). */
  readonly id: string
  /** The dedupKey identity ('' for derived edges, which need no dedup). */
  readonly dedupKey: string
  readonly rel: EvidenceGraphRel
  readonly src: string
  readonly dst: string
  readonly ts: string
  readonly actor: LedgerActor
  /** The ledger row this edge stands on — the audit trail's whole point. */
  readonly sourceEventId: string
  /** The one-line declaration rationale (or the derived edge's label). */
  readonly note: string | null
  readonly retracted: boolean
  readonly retractedAt: string | null
  readonly retractedBy: LedgerActor | null
  /** The retraction event's id (UI 溯源 uses the same channel as edges). */
  readonly retractEventId: string | null
  /** The retraction's one-line reason, verbatim. */
  readonly retractReason: string | null
  readonly scope: {
    readonly projectId: string | null
    readonly ideaId: string | null
    readonly claimId: string | null
  }
}

/** One supports/contradicts pair onto the same claim (active口径 only). */
export interface EvidenceConflict {
  readonly nodeKey: string
  readonly supporting: EvidenceGraphEdge
  readonly contradicting: EvidenceGraphEdge
}

/** One row of a claim's evidence history (v1.1 §2.4). */
export interface EvidenceTimelineEntry {
  readonly sourceEventId: string
  readonly ts: string
  /** The declared relation, or the retraction action for retract rows. */
  readonly rel: string
  readonly actor: LedgerActor
  readonly note: string | null
  /** Rendered inline with a strikethrough (superseded or retracted). */
  readonly retracted: boolean
}

/** One claim's evidence history (v1.1 §2.4). */
export interface EvidenceClaimHistory {
  /** `claim:<claimId>` — the UUID key is stable under alias merges. */
  readonly claimKey: string
  /** The truncated claim text, or the raw claimKey when unresolvable. */
  readonly claimLabel: string
  /** The current terminal status, or null while nothing has declared one. */
  readonly status: string | null
  /** Active口径 counts (retracted edges never count). */
  readonly supportsCount: number
  readonly contradictsCount: number
  readonly hasConflict: boolean
  /** The accumulation story, ts-ascending. */
  readonly history: readonly EvidenceTimelineEntry[]
}

/** One research line's evidence-history group (v1.1 §2.4). */
export interface EvidenceTimelineGroup {
  /** `idea:<id>` / `project:<id>` — the claim's most specific attribution. */
  readonly key: string
  readonly kind: 'idea' | 'project'
  /** The wiki title when resolvable, else the raw key. */
  readonly label: string | null
  /** The newest entry ts in the group (groups sort by this, descending). */
  readonly lastActiveAt: string
  readonly claims: readonly EvidenceClaimHistory[]
}

/** The fold's honesty counters (I2 — unestimable is not zero). */
export interface EvidenceGraphStats {
  /** Evidence edges in the fold (derived `narrates` rows never count). */
  readonly totalEdges: number
  /** Active口径 (last declaration is `added`). */
  readonly activeEdges: number
  /** Currently retracted edges (kept in `edges[]`, never deleted). */
  readonly retractedEdges: number
  /** Retraction events pointing at a dedupKey that never appeared. */
  readonly retractOrphans: number
  /** Duplicate declarations merged by dedupKey (append-only idempotence). */
  readonly duplicateEdges: number
  /** Alias unifications that actually joined two distinct roots. */
  readonly aliasMerges: number
  /** Provided alias values that failed normalization (counted, not guessed). */
  readonly unnormalizable: number
}

/** The composed evidence graph (the pure fold's product). */
export interface EvidenceGraph {
  readonly derivationVersion: number
  readonly nodes: readonly EvidenceGraphNode[]
  readonly edges: readonly EvidenceGraphEdge[]
  readonly conflicts: readonly EvidenceConflict[]
  /** The timeline projection (v1.1 §2.4): claim-centric, line-grouped. */
  readonly timeline: readonly EvidenceTimelineGroup[]
  readonly stats: EvidenceGraphStats
}

/** A derived-edge record assembled from an existing action. */
interface DerivedEdge {
  readonly event: EventRecord
  readonly rel: EvidenceGraphRel
  readonly src: string | null
  readonly dst: string | null
  readonly label: string | null
}

/** One parsed `evidence.edge.added` declaration. */
interface EdgeDeclaration {
  readonly event: EventRecord
  readonly dedupKey: string
  readonly rel: EvidenceEdgeRel
  readonly src: string
  readonly dst: string
  readonly note: string | null
  /** Normalized alias node keys (already validated; failures counted elsewhere). */
  readonly aliases: readonly string[]
}

/** Read one optional string off a JSON payload value. */
function readString(value: LedgerJsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/** Read one optional nested string off the `keys` alias object. */
function readAliasKey(keys: LedgerJsonValue, name: string): string | null {
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) return null
  return readString((keys as Record<string, LedgerJsonValue>)[name])
}

/**
 * Map one ledger line id (`<ideaId>` | `project:<projectId>`) to the graph's
 * node-key spelling (`idea:<id>` | `proj:<id>`).
 */
function lineNodeKey(lineId: string | null): string | null {
  if (lineId === null) return null
  if (lineId.startsWith('project:')) return `proj:${lineId.slice('project:'.length)}`
  return `idea:${lineId}`
}

/** The events of one fold window, in the canonical (ts, id) order. */
function windowEvents(events: readonly EventRecord[], window: EvidenceGraphWindow): EventRecord[] {
  const fromMs = window.since === null ? Number.NEGATIVE_INFINITY : (tsToMs(window.since) ?? Number.NEGATIVE_INFINITY)
  const toMs = window.until === null ? Number.POSITIVE_INFINITY : (tsToMs(window.until) ?? Number.POSITIVE_INFINITY)
  const sliced = sliceEvents(events, fromMs, toMs)
  return window.projectId === null ? sliced : sliced.filter(event => event.refs.projectId === window.projectId)
}

/**
 * Deterministic union-find over alias node keys: the root of every set is
 * always its lexicographically smallest member, so the canonical node key
 * does not depend on the order the events arrived in.
 */
class AliasUnionFind {
  private readonly parent = new Map<string, string>()

  /** All keys the union-find has seen (any order; callers sort). */
  allKeys(): readonly string[] {
    return [...this.parent.keys()]
  }

  find(key: string): string {
    const existing = this.parent.get(key)
    if (existing === undefined) {
      this.parent.set(key, key)
      return key
    }
    if (existing === key) return key
    const root = this.find(existing)
    this.parent.set(key, root)
    return root
  }

  /** Join two keys; true when two distinct roots actually merged. */
  union(left: string, right: string): boolean {
    const leftRoot = this.find(left)
    const rightRoot = this.find(right)
    if (leftRoot === rightRoot) return false
    const [smaller, larger] = leftRoot < rightRoot ? [leftRoot, rightRoot] : [rightRoot, leftRoot]
    this.parent.set(larger, smaller)
    return true
  }
}

/** Truncate one claim label to the timeline's display width. */
function claimLabelOf(text: string | undefined, claimKey: string): string {
  if (text === undefined || text.trim() === '') return claimKey
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

/** The frozen scope triple of one event's refs. */
function scopeOf(event: EventRecord): EvidenceGraphEdge['scope'] {
  return Object.freeze({
    projectId: event.refs.projectId ?? null,
    ideaId: event.refs.ideaId ?? null,
    claimId: event.refs.claimId ?? null,
  })
}

/**
 * Derive the evidence graph over one window (the pure fold; v1.0 §1.3 edge
 * table + v1.1 §2.1 retraction resolution + v1.1 §2.4 timeline projection).
 * @param events - ledger events, ANY order (ordered internally).
 * @param wiki - the wiki tables for labels and claim statuses.
 * @param window - optional ISO bounds + project scope (null opens the bound).
 * @returns the composed graph, deterministic for a given event set.
 */
export function deriveEvidenceGraph(
  events: readonly EventRecord[],
  wiki: EvidenceWikiSnapshot,
  window: EvidenceGraphWindow = { since: null, until: null, projectId: null },
): EvidenceGraph {
  const ordered = orderedEvents(windowEvents(events, window))
  const byId = new Map(ordered.map(event => [event.id, event] as const))
  let unnormalizable = 0

  /* 1. Parse the two evidence actions; everything malformed is counted. */
  const declarations: EdgeDeclaration[] = []
  const declarationKeyByEvent = new Map<string, string>()
  const retracts: { readonly event: EventRecord; readonly dedupKey: string; readonly reason: string | null }[] = []
  for (const event of ordered) {
    if (event.action === EVIDENCE_EDGE_ADDED_ACTION) {
      const rel = readString(event.payload['rel'])
      const src = readString(event.payload['src'])
      const dst = readString(event.payload['dst'])
      if (rel === null || !isEvidenceEdgeRel(rel)
        || src === null || dst === null
        || !isValidNodeKey(src) || !isValidNodeKey(dst)) {
        unnormalizable += 1
        continue
      }
      const rawDedup = readString(event.payload['dedupKey'])
      const dedupKey = rawDedup !== null && isDedupKey(rawDedup)
        ? rawDedup
        : dedupKeyOf(rel, src, dst, evidenceScopeOf(event.refs))
      const keys = event.payload['keys']
      const aliases: string[] = []
      if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
        const arxiv = readAliasKey(keys, 'arxiv')
        if (arxiv !== null) {
          if (arxiv.length > 0 && arxiv.length <= ALIAS_MAX_CHARS && !/\s/.test(arxiv)) {
            aliases.push(`lit:arxiv:${arxiv}`)
          } else {
            unnormalizable += 1
          }
        }
        const doi = readAliasKey(keys, 'doi')
        if (doi !== null) {
          const normalized = normalizeDoi(doi)
          if (normalized === null) unnormalizable += 1
          else aliases.push(`lit:doi:${normalized}`)
        }
        const url = readAliasKey(keys, 'url')
        if (url !== null) {
          const normalized = normalizeUrl(url)
          if (normalized === null) unnormalizable += 1
          else aliases.push(`lit:url:${normalized}`)
        }
        const titleFp = readAliasKey(keys, 'titleFp')
        if (titleFp !== null) {
          if (isTitleFingerprint(titleFp)) aliases.push(`lit:title:${titleFp}`)
          else unnormalizable += 1
        }
      }
      const note = readString(event.payload['note'])
      declarations.push(Object.freeze({ event, dedupKey, rel, src, dst, note, aliases: Object.freeze(aliases) }))
      declarationKeyByEvent.set(event.id, dedupKey)
    } else if (event.action === EVIDENCE_EDGE_RETRACTED_ACTION) {
      const dedupKey = readString(event.payload['dedupKey'])
      if (dedupKey === null || !isDedupKey(dedupKey)) {
        unnormalizable += 1
        continue
      }
      const reason = readString(event.payload['reason'])
      retracts.push(Object.freeze({ event, dedupKey, reason }))
    }
  }

  /* 2. Dedup: the earliest declaration per dedupKey survives. */
  const earliest = new Map<string, EdgeDeclaration>()
  for (const declaration of declarations) {
    if (!earliest.has(declaration.dedupKey)) earliest.set(declaration.dedupKey, declaration)
  }
  const duplicateEdges = declarations.length - earliest.size

  /* 3. Retraction resolution: last-declaration-wins per dedupKey. */
  const activeByDedup = new Map<string, boolean>()
  const retractByDedup = new Map<string, { ts: string; actor: LedgerActor; eventId: string; reason: string | null }>()
  for (const event of ordered) {
    if (event.action === EVIDENCE_EDGE_ADDED_ACTION) {
      const dedupKey = declarationKeyByEvent.get(event.id)
      if (dedupKey !== undefined) activeByDedup.set(dedupKey, true)
    } else if (event.action === EVIDENCE_EDGE_RETRACTED_ACTION) {
      const item = retracts.find(retract => retract.event.id === event.id)
      if (item === undefined) continue
      activeByDedup.set(item.dedupKey, false)
      retractByDedup.set(item.dedupKey, {
        ts: event.ts,
        actor: event.actor,
        eventId: event.id,
        reason: item.reason,
      })
    }
  }
  const retractOrphans = retracts.filter(retract => !earliest.has(retract.dedupKey)).length

  /* 4. Alias union-find (deterministic min-key root). */
  const aliases = new AliasUnionFind()
  let aliasMerges = 0
  for (const declaration of earliest.values()) {
    if (declaration.aliases.length === 0) continue
    const litKey = declaration.dst.startsWith('lit:')
      ? declaration.dst
      : (declaration.src.startsWith('lit:') ? declaration.src : null)
    if (litKey === null) continue
    for (const alias of declaration.aliases) {
      if (aliases.union(litKey, alias)) aliasMerges += 1
    }
  }
  // Fold-derived title fingerprints of imported papers (v1.0 §2.4): two
  // imports of the same paper under different arXiv versions merge here
  // without touching any existing emission point.
  for (const event of ordered) {
    if (event.action !== 'literature.paper.imported' || event.refs.paperId === undefined) continue
    const title = readString(event.payload['title'])
    if (title === null) continue
    const fingerprint = titleFingerprint(title)
    if (fingerprint === null) continue
    if (aliases.union(`lit:arxiv:${event.refs.paperId}`, `lit:title:${fingerprint}`)) aliasMerges += 1
  }

  /* 5. Derived edges from existing actions (zero new emission points). */
  const derived: DerivedEdge[] = []
  for (const event of ordered) {
    switch (event.action) {
      case 'literature.paper.imported': {
        if (event.refs.paperId === undefined) break
        derived.push({
          event,
          rel: 'imports',
          src: event.refs.projectId === undefined ? null : `proj:${event.refs.projectId}`,
          dst: `lit:arxiv:${event.refs.paperId}`,
          label: readString(event.payload['title']),
        })
        break
      }
      case 'compute.job.settled': {
        if (event.refs.jobId === undefined) break
        derived.push({
          event,
          rel: 'yields',
          src: event.refs.experimentId !== undefined
            ? `exp:${event.refs.experimentId}`
            : (event.refs.projectId === undefined ? null : `proj:${event.refs.projectId}`),
          dst: `run:${event.refs.jobId}`,
          label: readString(event.payload['status']),
        })
        break
      }
      case 'writing.compile.settled': {
        if (event.refs.projectId === undefined) break
        derived.push({
          event,
          rel: 'yields',
          src: `proj:${event.refs.projectId}`,
          dst: `result:compile:${event.id}`,
          label: readString(event.payload['issues']),
        })
        break
      }
      case 'cbe.moment.pin': {
        const targetEventId = readString(event.payload['targetEventId'])
        if (targetEventId === null) break
        const target = byId.get(targetEventId)
        // The pin's src attributes through the anchored event's line (the
        // pin event's own line as the fallback), dst is the moment node.
        derived.push({
          event,
          rel: 'pinned-as',
          src: lineNodeKey(lineOf(target ?? event)),
          dst: `moment:${targetEventId}`,
          label: readString(event.payload['note']),
        })
        break
      }
      case 'journal.entry.added': {
        // L2 narration: zero-weight, never enters the evidence stats; the
        // edge only exists when the entry attributes to a line at all.
        derived.push({
          event,
          rel: 'narrates',
          src: `journal:${event.id}`,
          dst: lineNodeKey(lineOf(event)),
          label: readString(event.payload['text']),
        })
        break
      }
      default:
        break
    }
  }

  /* 6. Assemble the edges (evidence first, then derived), alias-resolved. */
  const edges: EvidenceGraphEdge[] = []
  for (const [dedupKey, declaration] of earliest) {
    const retracted = activeByDedup.get(dedupKey) === false
    const retract = retractByDedup.get(dedupKey) ?? null
    edges.push(Object.freeze({
      id: declaration.event.id,
      dedupKey,
      rel: declaration.rel,
      src: aliases.find(declaration.src),
      dst: aliases.find(declaration.dst),
      ts: declaration.event.ts,
      actor: declaration.event.actor,
      sourceEventId: declaration.event.id,
      note: declaration.note,
      retracted,
      retractedAt: retract?.ts ?? null,
      retractedBy: retract?.actor ?? null,
      retractEventId: retract?.eventId ?? null,
      retractReason: retract?.reason ?? null,
      scope: scopeOf(declaration.event),
    }))
  }
  for (const item of derived) {
    if (item.src === null || item.dst === null) continue
    edges.push(Object.freeze({
      id: item.event.id,
      dedupKey: `derived:${item.event.id}`,
      rel: item.rel,
      src: aliases.find(item.src),
      dst: aliases.find(item.dst),
      ts: item.event.ts,
      actor: item.event.actor,
      sourceEventId: item.event.id,
      note: item.label,
      retracted: false,
      retractedAt: null,
      retractedBy: null,
      retractEventId: null,
      retractReason: null,
      scope: scopeOf(item.event),
    }))
  }
  edges.sort((left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id))

  /* 7. Nodes: endpoints unified through the alias map, labels resolved. */
  interface NodeAccum {
    readonly members: Set<string>
    firstTs: string
    lastTs: string
    sourceEventId: string
  }
  const accums = new Map<string, NodeAccum>()
  const touchNode = (key: string, ts: string, eventId: string): string => {
    const canonical = aliases.find(key)
    const existing = accums.get(canonical)
    if (existing === undefined) {
      accums.set(canonical, { members: new Set([canonical]), firstTs: ts, lastTs: ts, sourceEventId: eventId })
    } else {
      // The alias-membership pass seeds accums with '' sentinels; the first
      // real touch must always claim firstTs (any ts beats the sentinel).
      if (existing.firstTs === '' || ts < existing.firstTs) {
        existing.firstTs = ts
        existing.sourceEventId = eventId
      }
      if (existing.lastTs === '' || ts > existing.lastTs) existing.lastTs = ts
    }
    return canonical
  }
  // Alias membership: every key the union-find saw joins its canonical node.
  for (const member of aliases.allKeys()) {
    const canonical = aliases.find(member)
    const existing = accums.get(canonical)
    if (existing === undefined) {
      accums.set(canonical, { members: new Set([canonical, member]), firstTs: '', lastTs: '', sourceEventId: '' })
    } else {
      existing.members.add(member)
    }
  }
  for (const edge of edges) {
    touchNode(edge.src, edge.ts, edge.sourceEventId)
    touchNode(edge.dst, edge.ts, edge.sourceEventId)
  }
  // Labels: wiki titles first (stable), then payload labels in event order.
  const labels = new Map<string, string>()
  const offerLabel = (key: string, label: string | null): void => {
    if (label === null || label.trim() === '' || labels.has(aliases.find(key))) return
    labels.set(aliases.find(key), label)
  }
  for (const idea of wiki.ideas) offerLabel(`idea:${idea.id}`, idea.title)
  for (const project of wiki.projects) offerLabel(`proj:${project.id}`, project.title)
  for (const claim of wiki.claims) offerLabel(`claim:${claim.id}`, claimLabelOf(claim.text, `claim:${claim.id}`))
  for (const event of ordered) {
    if (event.action === 'literature.paper.imported') {
      offerLabel(`lit:arxiv:${event.refs.paperId ?? ''}`, readString(event.payload['title']))
    }
  }
  for (const declaration of declarations) {
    offerLabel(declaration.src, readString((declaration.event.payload['srcLabel'] as LedgerJsonValue | undefined)))
    offerLabel(declaration.dst, readString((declaration.event.payload['dstLabel'] as LedgerJsonValue | undefined)))
  }
  const nodes: EvidenceGraphNode[] = [...accums.entries()]
    .filter(([key, accum]) => key !== '' && accum.firstTs !== '')
    .map(([key, accum]) => {
      const kindIndex = key.indexOf(':')
      return Object.freeze({
        key,
        kind: kindIndex > 0 ? key.slice(0, kindIndex) : key,
        label: labels.get(key) ?? null,
        firstSeen: accum.firstTs,
        lastSeen: accum.lastTs,
        aliases: Object.freeze([...accum.members].filter(member => member !== key).sort()),
        sourceEventId: accum.sourceEventId,
      })
    })
    .sort((left, right) => left.key.localeCompare(right.key))

  /* 8. Conflicts: supports × contradicts onto the same claim, ACTIVE only. */
  const supportsByDst = new Map<string, EvidenceGraphEdge>()
  const contradictsByDst = new Map<string, EvidenceGraphEdge>()
  for (const edge of edges) {
    if (edge.retracted) continue
    if (edge.rel === 'supports' && !supportsByDst.has(edge.dst)) supportsByDst.set(edge.dst, edge)
    else if (edge.rel === 'contradicts' && !contradictsByDst.has(edge.dst)) contradictsByDst.set(edge.dst, edge)
  }
  const conflicts: EvidenceConflict[] = []
  for (const nodeKey of [...supportsByDst.keys()].sort()) {
    const supporting = supportsByDst.get(nodeKey)
    const contradicting = contradictsByDst.get(nodeKey)
    if (supporting === undefined || contradicting === undefined) continue
    conflicts.push(Object.freeze({ nodeKey, supporting, contradicting }))
  }

  /* 9. Timeline projection (v1.1 §2.4): claim-centric, line-grouped. */
  const lastAddedByDedup = new Map<string, string>()
  for (const declaration of declarations) lastAddedByDedup.set(declaration.dedupKey, declaration.event.id)
  // Per-claim attribution pool: the refs of every declaration and every
  // matching retract — the group is decided AFTER the pool is complete.
  interface ClaimAttribution { ideaId: string | null; projectId: string | null }
  const attribution = new Map<string, ClaimAttribution>()
  const offerAttribution = (claimId: string | undefined, refs: EventRecord['refs']): void => {
    if (claimId === undefined) return
    const current = attribution.get(claimId) ?? { ideaId: null, projectId: null }
    if (current.ideaId === null && refs.ideaId !== undefined) current.ideaId = refs.ideaId
    if (current.projectId === null && refs.projectId !== undefined) current.projectId = refs.projectId
    attribution.set(claimId, current)
  }
  for (const declaration of declarations) offerAttribution(declaration.event.refs.claimId, declaration.event.refs)
  for (const retract of retracts) {
    const declaration = earliest.get(retract.dedupKey)
    offerAttribution(retract.event.refs.claimId ?? declaration?.event.refs.claimId, retract.event.refs)
  }
  // Retract rows route to their claim through the retracted edge's declaration.
  const claimIdOfRetract = (retract: (typeof retracts)[number]): string | undefined =>
    retract.event.refs.claimId ?? earliest.get(retract.dedupKey)?.event.refs.claimId

  interface ClaimEntryDraft {
    readonly sourceEventId: string
    readonly ts: string
    readonly sortId: string
    readonly rel: string
    readonly actor: LedgerActor
    readonly note: string | null
    readonly retracted: boolean
  }
  interface ClaimHistoryAccum {
    readonly entries: ClaimEntryDraft[]
    lastActiveAt: string
  }
  const claimHistory = new Map<string, ClaimHistoryAccum>()
  const touchClaim = (claimId: string, ts: string): ClaimHistoryAccum => {
    const existing = claimHistory.get(claimId)
    if (existing === undefined) {
      const created: ClaimHistoryAccum = { entries: [], lastActiveAt: ts }
      claimHistory.set(claimId, created)
      return created
    }
    if (ts > existing.lastActiveAt) existing.lastActiveAt = ts
    return existing
  }
  for (const declaration of declarations) {
    const claimId = declaration.event.refs.claimId
    if (claimId === undefined) continue
    const store = touchClaim(claimId, declaration.event.ts)
    const superseded = lastAddedByDedup.get(declaration.dedupKey) !== declaration.event.id
    store.entries.push({
      sourceEventId: declaration.event.id,
      ts: declaration.event.ts,
      sortId: declaration.event.id,
      rel: declaration.rel,
      actor: declaration.event.actor,
      note: declaration.note,
      retracted: superseded || activeByDedup.get(declaration.dedupKey) === false,
    })
  }
  for (const retract of retracts) {
    const claimId = claimIdOfRetract(retract)
    if (claimId === undefined) continue
    const store = touchClaim(claimId, retract.event.ts)
    store.entries.push({
      sourceEventId: retract.event.id,
      ts: retract.event.ts,
      sortId: retract.event.id,
      rel: EVIDENCE_EDGE_RETRACTED_ACTION,
      actor: retract.event.actor,
      note: retract.reason,
      retracted: true,
    })
  }
  // Claim statuses: the latest terminal `knowledge.claim.set` wins, falling
  // back to the wiki record's current status.
  const lastClaimStatus = new Map<string, string>()
  for (const event of ordered) {
    if (event.action !== 'knowledge.claim.set' || event.refs.claimId === undefined) continue
    const status = readString(event.payload['status'])
    if (status === 'supported' || status === 'invalidated' || status === 'pending') {
      lastClaimStatus.set(event.refs.claimId, status)
    }
  }
  const wikiClaimById = new Map(wiki.claims.map(claim => [claim.id, claim] as const))
  const ideaTitleById = new Map(wiki.ideas.map(idea => [idea.id, idea.title] as const))
  const projectTitleById = new Map(wiki.projects.map(project => [project.id, project.title] as const))
  const activeCountFor = (claimId: string, rel: 'supports' | 'contradicts'): number =>
    edges.filter(edge => !edge.retracted && edge.rel === rel && edge.dst === `claim:${claimId}`).length

  interface GroupAccum {
    readonly kind: 'idea' | 'project'
    readonly key: string
    readonly label: string | null
    readonly claims: EvidenceClaimHistory[]
    lastActiveAt: string
  }
  const groups = new Map<string, GroupAccum>()
  for (const [claimId, store] of claimHistory) {
    const claimKey = `claim:${claimId}`
    const wikiClaim = wikiClaimById.get(claimId)
    const claimLabel = claimLabelOf(wikiClaim?.text, claimKey)
    const entries = [...store.entries].sort((left, right) => left.ts.localeCompare(right.ts) || left.sortId.localeCompare(right.sortId))
    const claim: EvidenceClaimHistory = Object.freeze({
      claimKey,
      claimLabel,
      status: lastClaimStatus.get(claimId) ?? wikiClaim?.status ?? null,
      supportsCount: activeCountFor(claimId, 'supports'),
      contradictsCount: activeCountFor(claimId, 'contradicts'),
      hasConflict: conflicts.some(conflict => conflict.nodeKey === claimKey),
      history: Object.freeze(entries.map(entry => Object.freeze({
        sourceEventId: entry.sourceEventId,
        ts: entry.ts,
        rel: entry.rel,
        actor: entry.actor,
        note: entry.note,
        retracted: entry.retracted,
      }))),
    })
    // Group by the claim's MOST SPECIFIC attribution across all its events
    // (ideaId wins; the project fallback applies to the whole claim —
    // a late-added ideaId never splits a claim across two groups).
    const attributed = attribution.get(claimId)
    let groupKey: string
    let groupKind: 'idea' | 'project'
    let groupLabel: string | null
    if (attributed?.ideaId !== undefined && attributed.ideaId !== null) {
      groupKind = 'idea'
      groupKey = `idea:${attributed.ideaId}`
      groupLabel = ideaTitleById.get(attributed.ideaId) ?? groupKey
    } else if (attributed?.projectId !== undefined && attributed.projectId !== null) {
      groupKind = 'project'
      groupKey = `project:${attributed.projectId}`
      groupLabel = projectTitleById.get(attributed.projectId) ?? groupKey
    } else {
      groupKind = 'project'
      groupKey = claimKey
      groupLabel = claimLabel
    }
    const existing = groups.get(groupKey)
    if (existing === undefined) {
      groups.set(groupKey, { kind: groupKind, key: groupKey, label: groupLabel, claims: [claim], lastActiveAt: store.lastActiveAt })
    } else {
      existing.claims.push(claim)
      if (store.lastActiveAt > existing.lastActiveAt) existing.lastActiveAt = store.lastActiveAt
    }
  }
  const timeline: EvidenceTimelineGroup[] = [...groups.values()]
    .map(group => Object.freeze({
      key: group.key,
      kind: group.kind,
      label: group.label,
      lastActiveAt: group.lastActiveAt,
      claims: Object.freeze([...group.claims].sort((left, right) => {
        const leftTs = left.history[left.history.length - 1]?.ts ?? ''
        const rightTs = right.history[right.history.length - 1]?.ts ?? ''
        return rightTs.localeCompare(leftTs) || left.claimKey.localeCompare(right.claimKey)
      })),
    }))
    .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt) || left.key.localeCompare(right.key))

  /* 10. Stats: evidence edges only — narrates never counts (L2 constitution). */
  const evidenceEdges = edges.filter(edge => edge.rel !== 'narrates')
  const stats: EvidenceGraphStats = Object.freeze({
    totalEdges: evidenceEdges.length,
    activeEdges: evidenceEdges.filter(edge => !edge.retracted).length,
    retractedEdges: evidenceEdges.filter(edge => edge.retracted).length,
    retractOrphans,
    duplicateEdges,
    aliasMerges,
    unnormalizable,
  })

  return Object.freeze({
    derivationVersion: EVIDENCE_GRAPH_DERIVATION_VERSION,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    conflicts: Object.freeze(conflicts),
    timeline: Object.freeze(timeline),
    stats,
  })
}

/**
 * Render one evidence graph as the 组会-friendly Markdown export (the
 * progress report's sibling sheet). The evidence-history chapters use the
 * ACTIVE口径 only — retracted edges appear in their own disclosure section,
 * never inside the counts (v1.1 risk note 2).
 * @param graph - the fold product.
 * @returns the Markdown document.
 */
export function renderEvidenceGraphMarkdown(graph: EvidenceGraph): string {
  const lines: string[] = []
  const push = (line = ''): void => { lines.push(line) }

  push('# Evidence Graph')
  push()
  push(`- Derivation: v${graph.derivationVersion}`)
  push(`- Edges: ${graph.stats.totalEdges} total · ${graph.stats.activeEdges} active · ${graph.stats.retractedEdges} retracted (active口径 unless noted)`)
  push(`- Nodes: ${graph.nodes.length} · Conflicts: ${graph.conflicts.length}`)
  push(`- Duplicates merged: ${graph.stats.duplicateEdges} · Alias merges: ${graph.stats.aliasMerges} · Unnormalizable: ${graph.stats.unnormalizable} · Retract orphans: ${graph.stats.retractOrphans}`)
  push()

  push('## Evidence history by research line')
  push()
  if (graph.timeline.length === 0) {
    push('_No claim-attributed evidence in the fold._')
  }
  for (const group of graph.timeline) {
    push(`### ${group.kind === 'idea' ? 'Line' : 'Project'}: ${group.label ?? group.key} (\`${group.key}\`)`)
    push()
    for (const claim of group.claims) {
      const conflictMark = claim.hasConflict ? ' · ⚠ conflict' : ''
      push(`#### ${claim.claimLabel} — ${claim.status ?? 'no status'} · supports ${claim.supportsCount} / contradicts ${claim.contradictsCount} (active)${conflictMark}`)
      push()
      if (claim.history.length === 0) {
        push('_No declarations._')
      } else {
        push('| Time | Relation | Actor | Note | Event |')
        push('| --- | --- | --- | --- | --- |')
        for (const entry of claim.history) {
          const mark = entry.retracted ? ' ~~retracted~~' : ''
          push(`| ${entry.ts} | \`${entry.rel}\`${mark} | ${entry.actor.kind}/${entry.actor.id} | ${entry.note ?? '—'} | \`${entry.sourceEventId}\` |`)
        }
      }
      push()
    }
  }

  push('## Conflicts')
  push()
  if (graph.conflicts.length === 0) {
    push('_No claim carries both an active support and an active contradiction._')
  } else {
    for (const conflict of graph.conflicts) {
      push(`- \`${conflict.nodeKey}\``)
      push(`  - supports: ${conflict.supporting.ts} \`${conflict.supporting.src}\` (${conflict.supporting.sourceEventId}) — ${conflict.supporting.note ?? '—'}`)
      push(`  - contradicts: ${conflict.contradicting.ts} \`${conflict.contradicting.src}\` (${conflict.contradicting.sourceEventId}) — ${conflict.contradicting.note ?? '—'}`)
    }
  }
  push()

  push('## Retracted edges')
  push()
  const retracted = graph.edges.filter(edge => edge.retracted)
  if (retracted.length === 0) {
    push('_Nothing has been retracted._')
  } else {
    for (const edge of retracted) {
      push(`- \`${edge.dedupKey}\` \`${edge.rel}\` ${edge.src} → ${edge.dst} · retracted at ${edge.retractedAt ?? '—'} by ${edge.retractedBy?.kind ?? '?'}/${edge.retractedBy?.id ?? '?'} · reason: ${edge.retractReason ?? '—'} · retract event \`${edge.retractEventId ?? '—'}\``)
    }
  }
  push()

  return lines.join('\n') + '\n'
}
