/**
 * Evidence Graph (v2) orchestration (PRD §13/§33): composes the header, the
 * deterministic temporal research map, the selection detail panel, and the
 * collapsible evidence audit. It owns interaction state only — selection,
 * the retraction confirmation, and the audit disclosure. It computes NO
 * geometry (the canvas renders the pure layout) and calls NO remote. The
 * audit layer reuses the v1 ledger list components, because a list IS the
 * right presentation for "what exactly happened" — it is simply no longer
 * the primary visual object.
 * @module dsh-client-ui-mimir/client/EvidenceGraphView
 */

import { useMemo, useState } from 'react'
import type {
  EvidenceClaimHistory,
  EvidenceGraphEdge,
  EvidenceGraphStats,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'
import type { ResearchEvidenceGraphSlice, ResearchEurekaSlice } from './controller.ts'
import type { ResearchT } from './view-common.ts'
import {
  evidenceRelKey,
  isStruckThrough,
  retractConfirmOf,
  type EvidenceRetractConfirm,
} from './evidence-graph-view.ts'
import { deriveEvidenceGraphLayout, type EvidenceNodeLayout } from './evidence-graph-layout.ts'
import { EvidenceGraphCanvas } from './EvidenceGraphCanvas.tsx'
import css from './EvidenceGraph.module.css'
import panelCss from './ResearchPanel.module.css'

/** One entry row of a claim's history (audit): time, spine, rel pill, note. */
function HistoryRow({ entry, onJump, t }: {
  readonly entry: EvidenceTimelineEntry
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  return (
    <li className={panelCss.ledgerRow} data-destructive={isStruckThrough(entry) || undefined}>
      <span className={panelCss.ledgerTime} title={entry.ts}>
        <span className={panelCss.ledgerTimeDate}>{entry.ts.slice(0, 10)}</span>
        <span className={panelCss.ledgerTimeClock}>{entry.ts.slice(11, 16)}</span>
      </span>
      <span className={panelCss.ledgerNode} aria-hidden />
      <div className={panelCss.ledgerBody}>
        <div className={panelCss.ledgerLine}>
          <span className={panelCss.tagPill} data-active={!isStruckThrough(entry) || undefined} data-struck={isStruckThrough(entry) || undefined}>
            {t(evidenceRelKey(entry.rel))}
          </span>
          <span className={panelCss.actorBadge}>{entry.actor.id !== '' ? entry.actor.id : entry.actor.kind}</span>
          {entry.note !== null && <span className={isStruckThrough(entry) ? panelCss.ledgerMark : undefined}>{entry.note}</span>}
        </div>
        <div className={panelCss.viewActions}>
          <button type="button" className={panelCss.retry} onClick={() => { onJump(entry.ts) }}>{t('evidence.provenance')}</button>
        </div>
      </div>
    </li>
  )
}

/** One claim's history block (audit): label, counts, and the full accumulation. */
function ClaimBlock({ claim, onJump, t }: {
  readonly claim: EvidenceClaimHistory
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  return (
    <div className={panelCss.reportCard}>
      <div className={panelCss.reportCardHead}>
        <h4 className={panelCss.reportCardTitle}>{claim.claimLabel}</h4>
        <div className={panelCss.ledgerLine}>
          {claim.status !== null && <span className={panelCss.actorBadge}>{t('evidence.claim.status', { status: claim.status })}</span>}
          <span className={panelCss.actorBadge}>{t('evidence.claim.counts', { supports: claim.supportsCount, contradicts: claim.contradictsCount })}</span>
          {claim.hasConflict && <span className={panelCss.ledgerMark}>{t('evidence.conflict')}</span>}
        </div>
      </div>
      <ul className={panelCss.ledgerList}>
        {claim.history.map(entry => <HistoryRow key={entry.sourceEventId} entry={entry} onJump={onJump} t={t} />)}
      </ul>
    </div>
  )
}

/** One research line's audit block. */
function TimelineGroupBlock({ group, onJump, t }: {
  readonly group: EvidenceTimelineGroup
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  return (
    <section>
      <h4 className={panelCss.reportCardTitle}>
        <span className={panelCss.tagPill} data-active={group.kind === 'idea' || undefined}>
          {t(group.kind === 'idea' ? 'evidence.kind.idea' : 'evidence.kind.project')}
        </span>
        {group.label ?? group.key}
      </h4>
      {group.claims.map(claim => <ClaimBlock key={claim.claimKey} claim={claim} onJump={onJump} t={t} />)}
    </section>
  )
}

/** The honesty counters line: every fold disclosure, never rounded away. */
function StatsLine({ stats, t }: { readonly stats: EvidenceGraphStats; readonly t: ResearchT }) {
  return (
    <p className={panelCss.hint}>
      {t('evidence.stats', { total: stats.totalEdges, active: stats.activeEdges, retracted: stats.retractedEdges })}
      {stats.retractOrphans > 0 || stats.duplicateEdges > 0 || stats.aliasMerges > 0 || stats.unnormalizable > 0
        ? ' · ' + t('evidence.stats.honesty', {
          orphans: stats.retractOrphans,
          duplicates: stats.duplicateEdges,
          aliases: stats.aliasMerges,
          unnormalizable: stats.unnormalizable,
        })
        : ''}
    </p>
  )
}

/** One flat edge row (audit): every edge, retracted included. */
function EdgeRow({ edge, onConfirm, onJump, t }: {
  readonly edge: EvidenceGraphEdge
  readonly onConfirm: (confirm: EvidenceRetractConfirm) => void
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  const confirm = retractConfirmOf(edge)
  return (
    <li className={panelCss.ledgerRow} data-destructive={edge.retracted || undefined}>
      <span className={panelCss.ledgerTime} title={edge.ts}>
        <span className={panelCss.ledgerTimeDate}>{edge.ts.slice(0, 10)}</span>
        <span className={panelCss.ledgerTimeClock}>{edge.ts.slice(11, 16)}</span>
      </span>
      <span className={panelCss.ledgerNode} aria-hidden />
      <div className={panelCss.ledgerBody}>
        <div className={panelCss.ledgerLine}>
          <span className={panelCss.tagPill} data-active={!edge.retracted || undefined}>{t(evidenceRelKey(edge.rel))}</span>
          <code className={panelCss.ledgerAction}>{edge.src} → {edge.dst}</code>
          {edge.note !== null && <span>{edge.note}</span>}
        </div>
        {edge.retracted && (
          <p className={panelCss.ledgerDetail}>{t('evidence.retractedAt', { at: edge.retractedAt ?? '', reason: edge.retractReason ?? '' })}</p>
        )}
        <div className={panelCss.viewActions}>
          <button type="button" className={panelCss.retry} onClick={() => { onJump(edge.ts) }}>{t('evidence.provenance')}</button>
          {confirm !== null && <button type="button" className={panelCss.btn} onClick={() => { onConfirm(confirm) }}>{t('evidence.retract')}</button>}
        </div>
      </div>
    </li>
  )
}

/** The selection detail panel (progressive disclosure, PRD §53). */
function DetailPanel({ node, edge, onJump, onConfirm, onClose, t }: {
  readonly node: EvidenceNodeLayout
  readonly edge: EvidenceGraphEdge | null
  readonly onJump: (ts: string) => void
  readonly onConfirm: (confirm: EvidenceRetractConfirm) => void
  readonly onClose: () => void
  readonly t: ResearchT
}) {
  const confirm = edge === null ? null : retractConfirmOf(edge)
  return (
    <div className={panelCss.reportCard}>
      <div className={panelCss.reportCardHead}>
        <h4 className={panelCss.reportCardTitle}>
          {node.rel !== '' && (
            <span className={panelCss.tagPill} data-active={!node.retracted || undefined} data-struck={node.retracted || undefined}>
              {t(evidenceRelKey(node.rel))}
            </span>
          )}
          <span className={panelCss.actorBadge}>{node.label}</span>
        </h4>
        <button type="button" className={panelCss.retry} onClick={onClose}>{t('evidence.retractCancel')}</button>
      </div>
      {edge !== null && (
        <p className={panelCss.ledgerDetail}><code className={panelCss.ledgerAction}>{edge.src} → {edge.dst}</code></p>
      )}
      {edge?.retracted && (
        <p className={panelCss.ledgerDetail}>{t('evidence.retractedAt', { at: edge.retractedAt ?? '', reason: edge.retractReason ?? '' })}</p>
      )}
      <div className={panelCss.viewActions}>
        {node.eventId !== null && (
          <button type="button" className={panelCss.retry} onClick={() => { onJump(node.ts) }}>{t('evidence.provenance')}</button>
        )}
        {confirm !== null && <button type="button" className={panelCss.btn} onClick={() => { onConfirm(confirm) }}>{t('evidence.retract')}</button>}
      </div>
    </div>
  )
}

/**
 * The evidence graph card: the temporal research map first, the raw audit
 * below as a collapsible disclosure.
 */
export function EvidenceGraphView({
  evidence, eureka, refreshEvidenceGraph, retractEvidence, jumpToProvenance, t,
}: {
  readonly evidence: ResearchEvidenceGraphSlice
  readonly eureka: ResearchEurekaSlice
  readonly refreshEvidenceGraph: () => void
  readonly retractEvidence: (dedupKey: string, reason?: string | undefined) => Promise<unknown>
  readonly jumpToProvenance: (ts: string) => void
  readonly t: ResearchT
}) {
  const [confirming, setConfirming] = useState<EvidenceRetractConfirm | null>(null)
  const [reason, setReason] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const view = evidence.view

  const layout = useMemo(
    () => (view === null
      ? null
      : deriveEvidenceGraphLayout(view.graph, { eurekaDeclarations: eureka.view?.declarations ?? [] })),
    [view, eureka.view],
  )
  const selectedNode = selectedId === null || layout === null ? null : layout.nodes.find(node => node.id === selectedId) ?? null
  const selectedEdge = selectedNode === null || selectedNode.eventId === null || view === null
    ? null
    : view.graph.edges.find(edge => edge.sourceEventId === selectedNode.eventId) ?? null

  const onConfirmRetract = async (): Promise<void> => {
    if (confirming === null) return
    await retractEvidence(confirming.dedupKey, reason.trim() === '' ? undefined : reason.trim())
    setConfirming(null)
    setReason('')
  }

  return (
    <section className={panelCss.reportCard}>
      <div className={panelCss.reportCardHead}>
        <div>
          <h3 className={panelCss.reportCardTitle}>{t('evidence.title')}</h3>
          <p className={panelCss.hint}>{t('evidence.graph.subtitle')}</p>
        </div>
        <div className={panelCss.viewActions}>
          <button
            type="button"
            className={panelCss.btn}
            onClick={refreshEvidenceGraph}
            disabled={evidence.status === 'loading'}
          >
            {t('evidence.refresh')}
          </button>
        </div>
      </div>

      {(evidence.status === 'cold' || evidence.status === 'loading') && <p className={panelCss.hint}>{t('evidence.loading')}</p>}
      {evidence.status === 'error' && (
        <p className={panelCss.failure} role="status">
          {evidence.failure?.message ?? t('evidence.failed')}
          <button type="button" className={panelCss.retry} onClick={refreshEvidenceGraph}>{t('error.retry')}</button>
        </p>
      )}

      {evidence.status === 'ready' && view !== null && layout !== null && (
        <>
          <div className={css.graphHeaderRow}>
            <span className={css.graphCounts}>
              {t('evidence.graph.counts', {
                nodes: view.graph.nodes.length,
                edges: view.graph.stats.totalEdges,
                conflicts: view.graph.conflicts.length,
              })}
            </span>
            {view.retrieval.truncated && (
              <span className={css.graphTruncated}>
                {t('evidence.graph.truncated', { hit: view.retrieval.eventsHit, total: view.retrieval.eventsTotal })}
              </span>
            )}
          </div>

          <StatsLine stats={view.graph.stats} t={t} />

          {view.graph.timeline.length === 0 ? (
            <p className={panelCss.hint}>{t('evidence.empty')}</p>
          ) : (
            <div className={css.graphViewport}>
              <EvidenceGraphCanvas layout={layout} selectedId={selectedId} onSelect={setSelectedId} t={t} />
            </div>
          )}

          {selectedNode !== null && (
            <DetailPanel
              node={selectedNode}
              edge={selectedEdge}
              onJump={jumpToProvenance}
              onConfirm={confirm => { setConfirming(confirm); setSelectedId(null) }}
              onClose={() => { setSelectedId(null) }}
              t={t}
            />
          )}

          {/* Evidence audit: conflicts + the full claim/edge history. */}
          <details className={css.graphAudit}>
            <summary className={panelCss.reportCardTitle}>{t('evidence.graph.auditTitle')}</summary>

            {view.graph.conflicts.length > 0 && (
              <>
                <h4 className={panelCss.reportCardTitle}>{t('evidence.conflicts.title')}</h4>
                <ul className={panelCss.ledgerList}>
                  {view.graph.conflicts.map(conflict => (
                    <li key={conflict.nodeKey} className={panelCss.ledgerRow}>
                      <span aria-hidden />
                      <span className={panelCss.ledgerNode} aria-hidden />
                      <div className={panelCss.ledgerBody}>
                        <div className={panelCss.ledgerLine}>
                          <span className={panelCss.tagPill} data-active>{t('evidence.rel.supports')}</span>
                          <code className={panelCss.ledgerAction}>{conflict.supporting.src}</code>
                          <span className={panelCss.tagPill} data-active>{t('evidence.rel.contradicts')}</span>
                          <code className={panelCss.ledgerAction}>{conflict.contradicting.src}</code>
                        </div>
                        <div className={panelCss.viewActions}>
                          <button type="button" className={panelCss.retry} onClick={() => { jumpToProvenance(conflict.supporting.ts) }}>{t('evidence.provenance')}</button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {view.graph.timeline.map(group => <TimelineGroupBlock key={group.key} group={group} onJump={jumpToProvenance} t={t} />)}

            <h4 className={panelCss.reportCardTitle}>{t('evidence.edges.title')}</h4>
            <ul className={panelCss.ledgerList}>
              {view.graph.edges.map(edge => <EdgeRow key={edge.id} edge={edge} onConfirm={setConfirming} onJump={jumpToProvenance} t={t} />)}
            </ul>
          </details>

          {confirming !== null && (
            <div className={panelCss.reportCard}>
              <p className={panelCss.ledgerDetail}>{t('evidence.retractTitle', { edge: confirming.label })}</p>
              <div className={panelCss.ledgerControls}>
                <input
                  className={panelCss.input}
                  type="text"
                  value={reason}
                  placeholder={t('evidence.retractReason')}
                  onChange={event => { setReason(event.target.value) }}
                />
                <button type="button" className={panelCss.btnPrimary} onClick={() => { void onConfirmRetract() }}>{t('evidence.retractConfirm')}</button>
                <button type="button" className={panelCss.btn} onClick={() => { setConfirming(null); setReason('') }}>{t('evidence.retractCancel')}</button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
