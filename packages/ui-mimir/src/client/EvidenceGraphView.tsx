/**
 * The evidence graph (v1) card of the ledger view: the claim-grouped
 * evidence-history timeline as the main view (v1.1 decision 6), with the
 * conflict pairs and the flat edge list as secondary disclosures. Retracted
 * rows stay inline with the strikethrough mark — the accumulation story is
 * the point, nothing is hidden. Every row carries its provenance jump back
 * into the raw ledger timeline; retraction is the panel's human-final-say
 * affordance with an inline confirmation (dedupKey-level, covers every
 * duplicate declaration). Zero graph layout libraries — this is a list, not
 * a force-directed canvas.
 * @module dsh-client-ui-mimir/client/EvidenceGraphView
 */

import { useState } from 'react'
import type {
  EvidenceClaimHistory,
  EvidenceGraphEdge,
  EvidenceGraphStats,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'
import type { ResearchEvidenceGraphSlice } from './controller.ts'
import type { ResearchT } from './view-common.ts'
import {
  evidenceRelKey,
  isStruckThrough,
  retractConfirmOf,
  type EvidenceRetractConfirm,
} from './evidence-graph-view.ts'
import css from './ResearchPanel.module.css'

/** One entry row of a claim's history: time, spine, rel pill, note. */
function HistoryRow({ entry, onJump, t }: {
  readonly entry: EvidenceTimelineEntry
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  return (
    <li className={css.ledgerRow} data-destructive={isStruckThrough(entry) || undefined}>
      <span className={css.ledgerTime} title={entry.ts}>
        <span className={css.ledgerTimeDate}>{entry.ts.slice(0, 10)}</span>
        <span className={css.ledgerTimeClock}>{entry.ts.slice(11, 16)}</span>
      </span>
      <span className={css.ledgerNode} aria-hidden />
      <div className={css.ledgerBody}>
        <div className={css.ledgerLine}>
          <span
            className={css.tagPill}
            data-active={!isStruckThrough(entry) || undefined}
            data-struck={isStruckThrough(entry) || undefined}
          >
            {t(evidenceRelKey(entry.rel))}
          </span>
          <span className={css.actorBadge}>
            {entry.actor.id !== '' ? entry.actor.id : entry.actor.kind}
          </span>
          {entry.note !== null && <span className={isStruckThrough(entry) ? css.ledgerMark : undefined}>{entry.note}</span>}
        </div>
        <div className={css.viewActions}>
          <button type="button" className={css.retry} onClick={() => { onJump(entry.ts) }}>
            {t('evidence.provenance')}
          </button>
        </div>
      </div>
    </li>
  )
}

/** One claim's history block: label, counts, and the full accumulation. */
function ClaimBlock({ claim, onJump, t }: {
  readonly claim: EvidenceClaimHistory
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  return (
    <div className={css.reportCard}>
      <div className={css.reportCardHead}>
        <h4 className={css.reportCardTitle}>{claim.claimLabel}</h4>
        <div className={css.ledgerLine}>
          {claim.status !== null && (
            <span className={css.actorBadge}>{t('evidence.claim.status', { status: claim.status })}</span>
          )}
          <span className={css.actorBadge}>
            {t('evidence.claim.counts', { supports: claim.supportsCount, contradicts: claim.contradictsCount })}
          </span>
          {claim.hasConflict && <span className={css.ledgerMark}>{t('evidence.conflict')}</span>}
        </div>
      </div>
      <ul className={css.ledgerList}>
        {claim.history.map(entry => (
          <HistoryRow key={entry.sourceEventId} entry={entry} onJump={onJump} t={t} />
        ))}
      </ul>
    </div>
  )
}

/** One timeline group: a research line (idea) or a whole project. */
function TimelineGroupBlock({ group, onJump, t }: {
  readonly group: EvidenceTimelineGroup
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  return (
    <section>
      <h4 className={css.reportCardTitle}>
        <span className={css.tagPill} data-active={group.kind === 'idea' || undefined}>
          {t(group.kind === 'idea' ? 'evidence.kind.idea' : 'evidence.kind.project')}
        </span>
        {group.label ?? group.key}
      </h4>
      {group.claims.map(claim => (
        <ClaimBlock key={claim.claimKey} claim={claim} onJump={onJump} t={t} />
      ))}
    </section>
  )
}

/** The honesty counters line: every fold disclosure, never rounded away. */
function StatsLine({ stats, t }: {
  readonly stats: EvidenceGraphStats
  readonly t: ResearchT
}) {
  return (
    <p className={css.hint}>
      {t('evidence.stats', {
        total: stats.totalEdges,
        active: stats.activeEdges,
        retracted: stats.retractedEdges,
      })}
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

/** One flat edge row of the secondary edge list. */
function EdgeRow({ edge, onConfirm, onJump, t }: {
  readonly edge: EvidenceGraphEdge
  readonly onConfirm: (confirm: EvidenceRetractConfirm) => void
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  const confirm = retractConfirmOf(edge)
  return (
    <li className={css.ledgerRow} data-destructive={edge.retracted || undefined}>
      <span className={css.ledgerTime} title={edge.ts}>
        <span className={css.ledgerTimeDate}>{edge.ts.slice(0, 10)}</span>
        <span className={css.ledgerTimeClock}>{edge.ts.slice(11, 16)}</span>
      </span>
      <span className={css.ledgerNode} aria-hidden />
      <div className={css.ledgerBody}>
        <div className={css.ledgerLine}>
          <span className={css.tagPill} data-active={!edge.retracted || undefined}>
            {t(evidenceRelKey(edge.rel))}
          </span>
          <code className={css.ledgerAction}>{edge.src} → {edge.dst}</code>
          {edge.note !== null && <span>{edge.note}</span>}
        </div>
        {edge.retracted && (
          <p className={css.ledgerDetail}>
            {t('evidence.retractedAt', {
              at: edge.retractedAt ?? '',
              reason: edge.retractReason ?? '',
            })}
          </p>
        )}
        <div className={css.viewActions}>
          <button type="button" className={css.retry} onClick={() => { onJump(edge.ts) }}>
            {t('evidence.provenance')}
          </button>
          {confirm !== null && (
            <button type="button" className={css.btn} onClick={() => { onConfirm(confirm) }}>
              {t('evidence.retract')}
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

/**
 * @param props - the evidence slice, the refresh/retract verbs, the raw-ledger
 *   provenance jump, and copy.
 * @returns the evidence graph card (timeline main view + disclosures).
 */
export function EvidenceGraphView({
  evidence, refreshEvidence, retractEvidence, jumpToProvenance, t,
}: {
  readonly evidence: ResearchEvidenceGraphSlice
  readonly refreshEvidence: () => void
  readonly retractEvidence: (dedupKey: string, reason?: string | undefined) => Promise<unknown>
  /** Load the raw ledger timeline around one event's ts (the provenance jump). */
  readonly jumpToProvenance: (ts: string) => void
  readonly t: ResearchT
}) {
  // The pending retraction confirmation (null while the card just reads).
  const [confirming, setConfirming] = useState<EvidenceRetractConfirm | null>(null)
  const [reason, setReason] = useState('')
  const view = evidence.view

  const onConfirmRetract = async (): Promise<void> => {
    if (confirming === null) return
    await retractEvidence(confirming.dedupKey, reason.trim() === '' ? undefined : reason.trim())
    setConfirming(null)
    setReason('')
  }

  return (
    <section className={css.reportCard}>
      <div className={css.reportCardHead}>
        <h3 className={css.reportCardTitle}>{t('evidence.title')}</h3>
        <div className={css.viewActions}>
          <button
            type="button"
            className={css.btn}
            onClick={refreshEvidence}
            disabled={evidence.status === 'loading'}
          >
            {t('evidence.refresh')}
          </button>
        </div>
      </div>
      {(evidence.status === 'cold' || evidence.status === 'loading') && (
        <p className={css.hint}>{t('evidence.loading')}</p>
      )}
      {evidence.status === 'error' && (
        <p className={css.failure} role="status">
          {evidence.failure?.message ?? t('evidence.failed')}
          <button type="button" className={css.retry} onClick={refreshEvidence}>
            {t('error.retry')}
          </button>
        </p>
      )}
      {evidence.status === 'ready' && view !== null && (
        <>
          <StatsLine stats={view.graph.stats} t={t} />

          {view.graph.timeline.length === 0 && <p className={css.hint}>{t('evidence.empty')}</p>}

          {/* The main view: research lines, claims, full inline history. */}
          {view.graph.timeline.map(group => (
            <TimelineGroupBlock
              key={group.key}
              group={group}
              onJump={jumpToProvenance}
              t={t}
            />
          ))}

          {/* Conflict pairs (active口径 only): the claim where the record
              itself disagrees, with both sides' retract affordances. */}
          {view.graph.conflicts.length > 0 && (
            <>
              <h4 className={css.reportCardTitle}>{t('evidence.conflicts.title')}</h4>
              <ul className={css.ledgerList}>
                {view.graph.conflicts.map(conflict => (
                  <li key={conflict.nodeKey} className={css.ledgerRow}>
                    <span className={css.ledgerNode} aria-hidden />
                    <div className={css.ledgerBody}>
                      <div className={css.ledgerLine}>
                        <span className={css.tagPill} data-active>{t('evidence.rel.supports')}</span>
                        <code className={css.ledgerAction}>{conflict.supporting.src}</code>
                        <span className={css.tagPill} data-active>{t('evidence.rel.contradicts')}</span>
                        <code className={css.ledgerAction}>{conflict.contradicting.src}</code>
                      </div>
                      <div className={css.viewActions}>
                        <button type="button" className={css.retry} onClick={() => { jumpToProvenance(conflict.supporting.ts) }}>
                          {t('evidence.provenance')}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* The pending retraction confirmation: one inline form, reason
              optional, dedupKey fixed by the affordance that opened it. */}
          {confirming !== null && (
            <div className={css.reportCard}>
              <p className={css.ledgerDetail}>{t('evidence.retractTitle', { edge: confirming.label })}</p>
              <div className={css.ledgerControls}>
                <input
                  className={css.input}
                  type="text"
                  value={reason}
                  placeholder={t('evidence.retractReason')}
                  onChange={event => { setReason(event.target.value) }}
                />
                <button type="button" className={css.btnPrimary} onClick={() => { void onConfirmRetract() }}>
                  {t('evidence.retractConfirm')}
                </button>
                <button type="button" className={css.btn} onClick={() => { setConfirming(null); setReason('') }}>
                  {t('evidence.retractCancel')}
                </button>
              </div>
            </div>
          )}

          {/* The flat edge list (secondary disclosure): every edge the fold
              holds, retracted included, each with its retract affordance. */}
          <details>
            <summary className={css.reportCardTitle}>{t('evidence.edges.title')}</summary>
            <ul className={css.ledgerList}>
              {view.graph.edges.map(edge => (
                <EdgeRow
                  key={edge.id}
                  edge={edge}
                  onConfirm={setConfirming}
                  onJump={jumpToProvenance}
                  t={t}
                />
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  )
}
