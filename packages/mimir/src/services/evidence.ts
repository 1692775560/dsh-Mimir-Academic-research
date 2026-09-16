/**
 * Evidence domain module: the Remote-facing verbs over the evidence graph
 * (v1). Two append-only write channels and one read:
 *
 *  - {@link addEvidenceEdge} — one explicit relation assertion, emitted as
 *    `evidence.edge.added` (panel channel: PANEL_ACTOR; agent channel: the
 *    `wiki_note` tool passes WIKI_AGENT_ACTOR in).
 *  - {@link retractEvidenceEdge} — one retraction declaration, emitted as
 *    `evidence.edge.retracted`, gated by the actor reverse-lookup: the panel
 *    (user) may retract any edge (human final say), an agent/subagent only
 *    its own declarations (the fold resolves state; THIS boundary owns
 *    authorization — v1.1 §2.1 / risk note 5).
 *  - {@link getEvidenceGraph} — load one ledger window and run the pure fold.
 *
 * Boundary discipline: every field cap is validated HERE, before emitting —
 * the service NEVER relies on `truncatePayload` (a truncated edge payload is
 * a destroyed edge). Emissions go through the best-effort `emitEvent`
 * contract, so a trail failure warns and is swallowed, never failing the
 * business response. The fold product is L1: it exists only in this result
 * and the UI's memory, never persisted.
 * @module dsh-mimir/src/services/evidence
 */

import type { ResearchWikiDomain } from '../store.ts'
import { emitEvent, PANEL_ACTOR } from '../ledger.ts'
import { LIST_EVENTS_MAX_LIMIT, listEvents } from '../ledger.ts'
import type { LedgerActor } from '../types.ts'
import type {
  AddEvidenceEdgeRequest,
  ResearchAddEvidenceEdgeResult,
  ResearchGetEvidenceGraphResult,
  ResearchRetractEvidenceEdgeResult,
  RetractEvidenceEdgeRequest,
} from '../types.ts'
import { loadLedgerWindow, wikiSnapshot } from './ledger.ts'
import {
  EVIDENCE_EDGE_ADDED_ACTION,
  EVIDENCE_EDGE_RETRACTED_ACTION,
  EVIDENCE_EDGE_RELS,
  deriveEvidenceGraph,
} from '../evidence-graph.ts'
import type { EvidenceGraphWindow } from '../evidence-graph.ts'
import {
  ALIAS_MAX_CHARS,
  LABEL_MAX_CHARS,
  NOTE_MAX_CHARS,
  dedupKeyOf,
  evidenceScopeOf,
  isDedupKey,
  isTitleFingerprint,
  isValidNodeKey,
  normalizeDoi,
  normalizeUrl,
  queryKeyOf,
} from '../evidence-identity.ts'
import { rejected, success } from './common.ts'

/** Everything the evidence domain functions need from the service scope. */
export interface EvidenceDeps {
  /** Open research-wiki domain (the ledger's events table lives here). */
  readonly domain: ResearchWikiDomain
}

/** Hard cap of one evidence-edge payload's JSON form (reject BEFORE emitting). */
export const EVIDENCE_EDGE_PAYLOAD_MAX_CHARS = 1500
/** Hard cap of one retraction payload's JSON form (v1.1 §2.1). */
export const EVIDENCE_RETRACT_PAYLOAD_MAX_CHARS = 512

/** Build a frozen failure with an optional detail field. */
function invalidInput(message: string) {
  return rejected({ code: 'invalid-input', message })
}

/** Whether one optional string fits one cap. */
function fitsCap(value: string | undefined, cap: number): boolean {
  return value === undefined || (value.length <= cap && !/[\u0000-\u001f\u007f]/.test(value))
}

/** Reject an unknown project ref (the wiki table is the authority). */
function unknownProject(deps: EvidenceDeps, projectId: string | undefined): boolean {
  return projectId !== undefined && deps.domain.table('projects').get(projectId) === undefined
}

/** Reject an unknown idea/claim ref. */
function unknownWikiRef(deps: EvidenceDeps, table: 'ideas' | 'claims', id: string | undefined): boolean {
  return id !== undefined && deps.domain.table(table).get(id) === undefined
}

/**
 * Normalize the caller-supplied alias keys: URLs and DOIs re-normalize
 * idempotently (callers may hand raw forms); arXiv ids and fingerprints are
 * shape-checked. Returns null when any provided alias fails — the caller
 * turns that into `invalid-input` (never a silent drop).
 */
function normalizedKeys(request: AddEvidenceEdgeRequest): {
  readonly arxiv?: string
  readonly doi?: string
  readonly url?: string
  readonly titleFp?: string
} | null {
  const keys = request.keys
  if (keys === undefined) return {}
  const out: { arxiv?: string; doi?: string; url?: string; titleFp?: string } = {}
  if (keys.arxiv !== undefined) {
    if (keys.arxiv === '' || keys.arxiv.length > ALIAS_MAX_CHARS || /\s/.test(keys.arxiv)) return null
    out.arxiv = keys.arxiv
  }
  if (keys.doi !== undefined) {
    const normalized = normalizeDoi(keys.doi)
    if (normalized === null) return null
    out.doi = normalized
  }
  if (keys.url !== undefined) {
    const normalized = normalizeUrl(keys.url)
    if (normalized === null || normalized.length > ALIAS_MAX_CHARS) return null
    out.url = normalized
  }
  if (keys.titleFp !== undefined) {
    if (!isTitleFingerprint(keys.titleFp)) return null
    out.titleFp = keys.titleFp
  }
  return out
}

/**
 * Declare one evidence edge: validate every field cap at this boundary,
 * compute the dedupKey server-side, and emit `evidence.edge.added` under the
 * caller's actor (best-effort — the response never fails on a trail error).
 * The edge's payload stays strictly under the JSON cap so the ledger's
 * truncation can never erase a field.
 * @param deps - open wiki domain.
 * @param request - the relation assertion (see {@link AddEvidenceEdgeRequest}).
 * @param actor - the declaring actor (panel default; the wiki tool passes its own).
 * @returns the edge's server-computed identity, or the settled failure.
 */
export async function addEvidenceEdge(
  deps: EvidenceDeps,
  request: AddEvidenceEdgeRequest,
  actor: LedgerActor = PANEL_ACTOR,
): Promise<ResearchAddEvidenceEdgeResult> {
  if (!EVIDENCE_EDGE_RELS.includes(request.rel as never)) {
    return invalidInput(`rel must be one of ${EVIDENCE_EDGE_RELS.join('|')}, got '${request.rel}'`)
  }
  if (typeof request.src !== 'string' || !isValidNodeKey(request.src)) {
    return invalidInput(`src must be a node key of the form kind:value (≤128 chars), got '${request.src}'`)
  }
  if (typeof request.dst !== 'string' || !isValidNodeKey(request.dst)) {
    return invalidInput(`dst must be a node key of the form kind:value (≤128 chars), got '${request.dst}'`)
  }
  if (!fitsCap(request.srcLabel, LABEL_MAX_CHARS)) {
    return invalidInput(`srcLabel is capped at ${LABEL_MAX_CHARS} characters`)
  }
  if (!fitsCap(request.dstLabel, LABEL_MAX_CHARS)) {
    return invalidInput(`dstLabel is capped at ${LABEL_MAX_CHARS} characters`)
  }
  if (!fitsCap(request.note, NOTE_MAX_CHARS)) {
    return invalidInput(`note is capped at ${NOTE_MAX_CHARS} characters`)
  }
  const keys = normalizedKeys(request)
  if (keys === null) {
    return invalidInput('keys carry an unnormalizable alias (check doi/url/titleFp shapes)')
  }
  if (unknownProject(deps, request.projectId)) {
    return rejected({ code: 'project-not-found', projectId: request.projectId as string })
  }
  if (unknownWikiRef(deps, 'ideas', request.ideaId)) {
    return invalidInput(`unknown ideaId: ${request.ideaId}`)
  }
  if (unknownWikiRef(deps, 'claims', request.claimId)) {
    return invalidInput(`unknown claimId: ${request.claimId}`)
  }
  const refs = {
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.ideaId === undefined ? {} : { ideaId: request.ideaId }),
    ...(request.claimId === undefined ? {} : { claimId: request.claimId }),
  }
  const payload = {
    rel: request.rel,
    src: request.src,
    dst: request.dst,
    ...(request.srcLabel === undefined ? {} : { srcLabel: request.srcLabel }),
    ...(request.dstLabel === undefined ? {} : { dstLabel: request.dstLabel }),
    ...(Object.keys(keys).length === 0 ? {} : { keys }),
    ...(request.note === undefined ? {} : { note: request.note }),
    dedupKey: dedupKeyOf(request.rel, request.src, request.dst, evidenceScopeOf(refs)),
  }
  if (JSON.stringify(payload).length > EVIDENCE_EDGE_PAYLOAD_MAX_CHARS) {
    return invalidInput(`evidence edge payload is capped at ${EVIDENCE_EDGE_PAYLOAD_MAX_CHARS} characters`)
  }
  // Best-effort by the ledger's call-site contract: the business response
  // never fails because the trail could not be written.
  await emitEvent(deps.domain, { actor, action: EVIDENCE_EDGE_ADDED_ACTION, refs, payload })
  return success({ dedupKey: payload.dedupKey, rel: request.rel, src: request.src, dst: request.dst })
}

/**
 * Retract one evidence edge by its dedupKey identity — the retraction covers
 * EVERY duplicate declaration of that edge (dedupKey-level granularity).
 * Permission (the human-final-say mirror): the panel actor retracts any
 * edge; an agent/subagent may only retract a edge it declared itself — this
 * boundary reverse-looks-up the dedupKey's current declaring event in the
 * ledger. When no declaration exists at all (an orphan retraction), the
 * panel passes (the fold discloses the orphan) and an agent is rejected
 * (an agent has no standing on an unknown edge).
 * @param deps - open wiki domain.
 * @param request - the dedupKey plus optional reason and scope refs.
 * @param actor - the retracting actor.
 * @returns the dedupKey, or the settled failure.
 */
export async function retractEvidenceEdge(
  deps: EvidenceDeps,
  request: RetractEvidenceEdgeRequest,
  actor: LedgerActor = PANEL_ACTOR,
): Promise<ResearchRetractEvidenceEdgeResult> {
  if (typeof request.dedupKey !== 'string' || !isDedupKey(request.dedupKey)) {
    return invalidInput(`dedupKey must be 32 hex characters, got '${request.dedupKey}'`)
  }
  if (!fitsCap(request.reason, NOTE_MAX_CHARS)) {
    return invalidInput(`reason is capped at ${NOTE_MAX_CHARS} characters`)
  }
  if (unknownProject(deps, request.projectId)) {
    return rejected({ code: 'project-not-found', projectId: request.projectId as string })
  }
  if (unknownWikiRef(deps, 'ideas', request.ideaId)) {
    return invalidInput(`unknown ideaId: ${request.ideaId}`)
  }
  if (unknownWikiRef(deps, 'claims', request.claimId)) {
    return invalidInput(`unknown claimId: ${request.claimId}`)
  }
  if (actor.kind === 'agent' || actor.kind === 'subagent') {
    // Reverse-lookup the current declaring event of this dedupKey (the last
    // `evidence.edge.added` carrying it). The fold never enforces this; the
    // boundary does, because only the boundary can read the ledger.
    const declarations = await listEvents(deps.domain, {
      actionPrefix: EVIDENCE_EDGE_ADDED_ACTION,
      limit: LIST_EVENTS_MAX_LIMIT,
    })
    const last = [...declarations]
      .reverse()
      .find(event => event.payload['dedupKey'] === request.dedupKey)
    if (last === undefined) {
      return invalidInput(`dedupKey has no declared edge to retract: ${request.dedupKey}`)
    }
    if (last.actor.kind !== actor.kind || last.actor.id !== actor.id) {
      return invalidInput(`retract denied: actor ${actor.kind}/${actor.id} did not declare ${request.dedupKey}`)
    }
  }
  const refs = {
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.ideaId === undefined ? {} : { ideaId: request.ideaId }),
    ...(request.claimId === undefined ? {} : { claimId: request.claimId }),
  }
  const payload = {
    dedupKey: request.dedupKey,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  }
  if (JSON.stringify(payload).length > EVIDENCE_RETRACT_PAYLOAD_MAX_CHARS) {
    return invalidInput(`retraction payload is capped at ${EVIDENCE_RETRACT_PAYLOAD_MAX_CHARS} characters`)
  }
  await emitEvent(deps.domain, { actor, action: EVIDENCE_EDGE_RETRACTED_ACTION, refs, payload })
  return success({ dedupKey: request.dedupKey })
}

/**
 * Read the evidence graph over one window: load the bounded ledger window
 * (newest-end, observations stripped, the real total reported) and run the
 * pure fold. A pure query — it writes nothing; the graph is L1 and lives
 * only in this response and the UI's memory.
 * @param deps - open wiki domain.
 * @param request - optional project scope and ISO-8601 bounds.
 * @returns the derived, label-resolved evidence graph view.
 */
export async function getEvidenceGraph(
  deps: EvidenceDeps,
  request: {
    projectId?: string | undefined
    since?: string | undefined
    until?: string | undefined
  } = {},
): Promise<ResearchGetEvidenceGraphResult> {
  if (request.projectId !== undefined
    && deps.domain.table('projects').get(request.projectId) === undefined) {
    return rejected({ code: 'project-not-found', projectId: request.projectId })
  }
  if (request.since !== undefined && Number.isNaN(Date.parse(request.since))) {
    return invalidInput(`since must be ISO-8601, got '${request.since}'`)
  }
  if (request.until !== undefined && Number.isNaN(Date.parse(request.until))) {
    return invalidInput(`until must be ISO-8601, got '${request.until}'`)
  }
  try {
    const filter = {
      ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      ...(request.since === undefined ? {} : { since: request.since }),
      ...(request.until === undefined ? {} : { until: request.until }),
    }
    const folded = await loadLedgerWindow(deps.domain, filter, 'evidence graph')
    const wiki = wikiSnapshot(deps.domain)
    // Resolve the effective bounds once. An unbounded read folds against an
    // OPEN upper bound (until: null → +∞): a default `until = now` is
    // EXCLUSIVE and would silently drop an event emitted in the same
    // millisecond as this read (the same-ms write→read race). The wire view
    // still reports a captured timestamp, so the response contract is
    // unchanged. `since` uses epoch 0, an inclusive lower bound — no race.
    const since = request.since ?? new Date(0).toISOString()
    const until = request.until ?? null
    const window: EvidenceGraphWindow = {
      since,
      until,
      projectId: request.projectId ?? null,
    }
    const graph = deriveEvidenceGraph(folded.events, wiki, window)
    return success({
      derivedAt: new Date().toISOString(),
      window: Object.freeze({ since, until: until ?? new Date().toISOString() }),
      retrieval: Object.freeze({
        eventsHit: folded.events.length,
        eventsTotal: folded.total,
        truncated: folded.truncated,
      }),
      graph,
    })
  } catch (error) {
    console.warn('[mimir]', 'the evidence graph could not be derived', error)
    return rejected({ code: 'operation-failed', message: 'the evidence graph could not be derived' })
  }
}

/** Re-exported so the wiki tool channel computes query nodes identically. */
export { queryKeyOf }
