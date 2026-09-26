/**
 * Evidence graph (v1) view-model helpers: the rel→copy key map, the
 * retraction confirmation parameters, and the provenance jump filter. Pure
 * glue between the fold's structured product and the card — no layout, no
 * graph library (the v1 constraint), everything re-derivable.
 * @module dsh-client-ui-mimir/client/evidence-graph-view
 */

import type {
  EvidenceGraphEdge,
  EvidenceTimelineEntry,
  ResearchEventFilter,
} from 'dsh-mimir/types'
import type { ResearchKey } from './locales.ts'
import { windowDays, type LedgerWindow } from './ledger-view.ts'

/**
 * The evidence graph's window request — the exact contract of the host's
 * `getEvidenceGraph` verb: optional project scope plus ISO-8601 bounds
 * (`since` inclusive, `until` = now). No list-only fields (`limit`, `order`)
 * ever cross this boundary.
 */
export interface EvidenceGraphRequest {
  readonly projectId?: string | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
}

/**
 * Translate the ledger's authoritative window + project scope into the
 * evidence graph's window request (the SAME resolved semantics as
 * `ledgerWindowFilter`: bounded windows get `since = now − days`, `all` opens
 * the lower bound, `until` is always now). The ledger owns this state; the
 * graph never grows a second filter system.
 * @param window - the ledger's selected time window.
 * @param projectId - the ledger's resolved project scope, or null.
 * @param nowMs - the wall clock (injectable for tests).
 * @returns the request for one `getEvidenceGraph` call.
 */
export function evidenceGraphRequestOf(
  window: LedgerWindow,
  projectId: string | null,
  nowMs: number,
): EvidenceGraphRequest {
  const days = windowDays(window)
  return {
    ...(projectId === null ? {} : { projectId }),
    ...(days === null ? {} : { since: new Date(nowMs - days * 86_400_000).toISOString() }),
    until: new Date(nowMs).toISOString(),
  }
}

/** The raw-timeline jump window around one provenance event (±1 day). */
const PROVENANCE_SPAN_MS = 86_400_000

/** The retract action keys of a timeline entry that is not an edge rel. */
const RETRACT_ROW_REL = 'evidence.edge.retracted'

/**
 * Locale key of one timeline entry's relation. Retract rows carry the raw
 * action string, so they map onto their own copy key.
 */
export function evidenceRelKey(rel: string): ResearchKey {
  if (rel === RETRACT_ROW_REL) return 'evidence.rel.retractRow'
  return `evidence.rel.${rel}` as ResearchKey
}

/**
 * Whether one timeline entry renders with the strikethrough mark: a
 * superseded declaration or a retract row — the accumulation story stays
 * fully inline (v1.1 §2.4), nothing is hidden.
 */
export function isStruckThrough(entry: EvidenceTimelineEntry): boolean {
  return entry.retracted
}

/** The confirmation parameters of one retraction (what the card asks about). */
export interface EvidenceRetractConfirm {
  /** The edge's server-computed identity (retracts every duplicate). */
  readonly dedupKey: string
  /** The edge's human-readable shape, shown in the confirmation line. */
  readonly label: string
}

/**
 * Build the retraction confirmation for one edge, or null when the edge
 * carries no retraction affordance: already-retracted edges (idempotence
 * belongs to the fold, not to more writes) and derived edges (they have no
 * dedupKey and cannot be retracted — the trail that produced them is the
 * write itself).
 */
export function retractConfirmOf(edge: EvidenceGraphEdge): EvidenceRetractConfirm | null {
  if (edge.retracted || edge.dedupKey === '') return null
  return Object.freeze({ dedupKey: edge.dedupKey, label: `${edge.rel} ${edge.src} → ${edge.dst}` })
}

/**
 * The raw-ledger-timeline filter that frames one provenance event: a ±1-day
 * window is enough to show the row in context without dragging the whole
 * history into the raw timeline.
 */
export function provenanceFilter(ts: string): ResearchEventFilter {
  const parsed = Date.parse(ts)
  const anchor = Number.isNaN(parsed) ? Date.now() : parsed
  return {
    since: new Date(anchor - PROVENANCE_SPAN_MS).toISOString(),
    until: new Date(anchor + PROVENANCE_SPAN_MS).toISOString(),
  }
}
