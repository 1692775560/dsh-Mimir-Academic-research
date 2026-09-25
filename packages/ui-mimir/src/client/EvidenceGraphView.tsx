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

import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
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
import {
  buildLaneGroups,
  type LaneDot,
  type LaneGroupGraph,
} from './evidence-lane-graph.ts'
import css from './ResearchPanel.module.css'

/** Horizontal distance between two claim lanes (px). */
const LANE_W = 26
/** Vertical distance between two dots (px) — also the click-target height. */
const ROW_H = 28
/** Structure palette: lane spines/chips cycle these by lane index. */
const LANE_PALETTE = ['#4176e6', '#1a9e63', '#b06000', '#8250df', '#d93026', '#0e7490']

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

const laneX = (lane: number): number => lane * LANE_W + LANE_W / 2 + 4
const rowY = (row: number): number => row * ROW_H + ROW_H / 2

/** One lane dot: a real button (focusable, provenance jump on click). */
function LaneDotButton({ dot, onJump }: {
  readonly dot: LaneDot
  readonly onJump: (ts: string) => void
}) {
  const label = `${dot.dateLabel} ${dot.timeLabel} · ${dot.rel}${dot.note !== null ? ` · ${dot.note}` : ''}`
  return (
    <button
      type="button"
      className={css.laneDot}
      data-shape={dot.shape}
      data-rel={dot.relClass}
      data-conflict={dot.conflict || undefined}
      style={{
        left: laneX(dot.lane) - 14,
        top: dot.row * ROW_H,
        '--lane-c': LANE_PALETTE[dot.lane % LANE_PALETTE.length],
      } as CSSProperties}
      title={label}
      aria-label={label}
      onClick={() => { onJump(dot.ts) }}
    />
  )
}

/** The wires + spines layer: one SVG behind the dot rows. */
function LaneWires({ layout }: { readonly layout: LaneGroupGraph }) {
  const width = layout.laneCount * LANE_W + 8
  const height = Math.max(layout.rowCount * ROW_H, ROW_H)
  return (
    <svg className={css.laneWires} width={width} height={height} aria-hidden>
      {layout.spans.map(span => (
        <line
          key={`spine-${span.lane}`}
          x1={laneX(span.lane)} x2={laneX(span.lane)}
          y1={rowY(span.firstRow)} y2={rowY(span.lastRow)}
          stroke={LANE_PALETTE[span.lane % LANE_PALETTE.length]}
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.45}
        />
      ))}
      {layout.wires.map(wire => {
        const x1 = laneX(wire.fromLane)
        const x2 = laneX(wire.toLane)
        const y1 = rowY(wire.fromRow)
        const y2 = rowY(wire.toRow)
        if (wire.kind === 'retract') {
          // A right-side loop back onto the lane: reads like a revert bump.
          const bulge = Math.max(x1 + 14, x2 + 14)
          return (
            <path
              key={`retract-${wire.fromRow}-${wire.toRow}`}
              d={`M ${x1} ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="#8a919e"
              strokeWidth={1.5}
              strokeDasharray="3 2"
            />
          )
        }
        const mid = (x1 + x2) / 2
        return (
          <path
            key={`cross-${wire.fromLane}-${wire.toLane}-${wire.fromRow}`}
            d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
            fill="none"
            stroke={LANE_PALETTE[wire.fromLane % LANE_PALETTE.length]}
            strokeWidth={2}
            opacity={0.9}
          />
        )
      })}
    </svg>
  )
}

/** The graph rendering of one timeline group: lane chips + the dot grid. */
function LaneGroupBlock({ layout, onJump, t }: {
  readonly layout: LaneGroupGraph
  readonly onJump: (ts: string) => void
  readonly t: ResearchT
}) {
  return (
    <section>
      <h4 className={css.reportCardTitle}>
        <span className={css.tagPill} data-active={layout.kind === 'idea' || undefined}>
          {t(layout.kind === 'idea' ? 'evidence.kind.idea' : 'evidence.kind.project')}
        </span>
        {layout.label ?? layout.key}
      </h4>
      <div className={css.laneLegend}>
        {layout.headers.map(header => (
          <span key={header.claimKey} className={css.laneChip}>
            <span
              className={css.laneChipDot}
              style={{ '--lane-c': LANE_PALETTE[header.hue % LANE_PALETTE.length] } as CSSProperties}
              aria-hidden
            />
            <span className={css.laneChipLabel}>{header.label}</span>
            {header.status !== null && <span className={css.actorBadge}>{t('evidence.claim.status', { status: header.status })}</span>}
            <span className={css.actorBadge}>
              {t('evidence.claim.counts', { supports: header.supports, contradicts: header.contradicts })}
            </span>
            {header.conflict && <span className={css.ledgerMark}>{t('evidence.conflict')}</span>}
          </span>
        ))}
      </div>
      <div className={css.laneGraph} style={{ height: Math.max(layout.rowCount * ROW_H, ROW_H) }}>
        <LaneWires layout={layout} />
        {/* Dots live directly on the lane grid (not inside the rows), so
            their lane-x coordinate is the single source of alignment with
            the spines and wires behind them. */}
        {layout.dots.map(dot => (
          <LaneDotButton key={dot.id} dot={dot} onJump={onJump} />
        ))}
        {layout.dots.map(dot => (
          <div key={`row-${dot.id}`} className={css.laneRow} style={{ top: dot.row * ROW_H, left: layout.laneCount * LANE_W + 16 }}>
            {dot.dateFirst && <span className={css.laneDay}>{dot.dateLabel}</span>}
            <span className={css.laneTime}>{dot.timeLabel}</span>
            <span className={css.tagPill} data-active={!dot.retracted || undefined} data-struck={dot.retracted || undefined}>
              {t(evidenceRelKey(dot.rel))}
            </span>
            <span className={css.actorBadge} data-hue={dot.actorHue}>{dot.actorLabel}</span>
            {dot.note !== null && (
              <span className={css.laneNote} data-struck={dot.retracted || undefined}>{dot.note}</span>
            )}
          </div>
        ))}
        {layout.rowCount === 0 && <p className={css.hint}>{t('evidence.empty')}</p>}
      </div>
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
  // The timeline's two renderings: the lane graph (structure at a glance)
  // and the v1 list (full affordances, screen-reader friendly).
  const [layout, setLayout] = useState<'graph' | 'list'>('graph')
  const view = evidence.view
  const laneGroups = useMemo(
    () => (view === null ? [] : buildLaneGroups(view.graph.timeline, view.graph.edges, view.graph.conflicts)),
    [view],
  )

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
          <span className={css.viewSwitch} role="tablist" aria-label={t('evidence.title')}>
            <button
              type="button"
              className={css.viewSwitchBtn}
              data-active={layout === 'graph' || undefined}
              aria-pressed={layout === 'graph'}
              onClick={() => { setLayout('graph') }}
            >
              {t('evidence.view.graph')}
            </button>
            <button
              type="button"
              className={css.viewSwitchBtn}
              data-active={layout === 'list' || undefined}
              aria-pressed={layout === 'list'}
              onClick={() => { setLayout('list') }}
            >
              {t('evidence.view.list')}
            </button>
          </span>
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

          {layout === 'graph' && view.graph.timeline.length > 0 && (
            <p className={css.hint}>{t('evidence.graph.legend')}</p>
          )}

          {view.graph.timeline.length === 0 && <p className={css.hint}>{t('evidence.empty')}</p>}

          {/* The main view: lane graph (structure at a glance) or the v1
              list (full inline history + affordances). */}
          {layout === 'graph'
            ? laneGroups.map(group => (
              <LaneGroupBlock key={group.key} layout={group} onJump={jumpToProvenance} t={t} />
            ))
            : view.graph.timeline.map(group => (
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
                    {/* The row grid expects the time cell first; conflicts
                        span a window, so theirs stays blank. */}
                    <span aria-hidden />
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
