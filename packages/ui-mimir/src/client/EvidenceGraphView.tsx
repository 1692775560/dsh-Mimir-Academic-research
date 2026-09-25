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
import type {
  EvidenceClaimHistory,
  EvidenceGraphEdge,
  EvidenceGraphStats,
  EvidenceTimelineEntry,
  EvidenceTimelineGroup,
} from 'dsh-mimir/types'
import type { ResearchEvidenceGraphSlice } from './controller.ts'
import type { ResearchKey } from './locales.ts'
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

/** Workflow-diagram geometry (px): tab column, time columns, rail rhythm. */
const TAB_W = 196
const COL_W = 78
const RAIL_H = 62
const AXIS_H = 32
const NODE_R = 7
/** Claim-tab palette (structure color, like branch labels in a git graph). */
const LANE_PALETTE = ['#4176e6', '#1a9e63', '#b06000', '#8250df', '#d93026', '#0e7490']
/** Node fill per relation class — shape carries semantics, color backs it up. */
const REL_FILL: Record<string, string> = {
  supports: '#1f9d55',
  contradicts: '#e5484d',
  tests: '#0e9888',
  retract: '#64748b',
  neutral: '#8a919e',
}
/** Status milestone tag fill per terminal claim status. */
const STATUS_FILL: Record<string, string> = {
  supported: '#1f9d55',
  invalidated: '#e5484d',
  pending: '#f59e0b',
}

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

const railY = (lane: number): number => AXIS_H + lane * RAIL_H + RAIL_H / 2
const colX = (col: number): number => TAB_W + 28 + col * COL_W
const shortLabel = (label: string): string => (label.length > 13 ? `${label.slice(0, 12)}…` : label)

/**
 * One node's glyph: shape first (disc / ×-disc / bullseye / hollow /
 * diamond), relation color second — the pair is recognizable at a glance
 * without any text. A slashed hollow disc marks a retracted edge.
 */
function NodeGlyph({ dot, selected }: { readonly dot: LaneDot; readonly selected: boolean }) {
  const fill = REL_FILL[dot.relClass] ?? REL_FILL.neutral
  const slashed = dot.shape === 'hollow' && dot.retracted
  return (
    <g transform={`translate(${colX(dot.col)} ${railY(dot.lane)})`}>
      {dot.conflict && <circle r={11.5} fill="none" stroke="#e5484d" strokeWidth={1.8} opacity={0.9} />}
      {selected && <circle r={12.5} fill="none" stroke="#4176e6" strokeWidth={2} />}
      {dot.shape === 'dot' && (
        <>
          <circle r={NODE_R} fill={fill} />
          <path d="M -3 0 L -0.8 2.4 L 3.4 -2.2" stroke="#fff" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {dot.shape === 'cross' && (
        <>
          <circle r={NODE_R} fill={fill} />
          <path d="M -2.6 -2.6 L 2.6 2.6 M 2.6 -2.6 L -2.6 2.6" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
      {dot.shape === 'bullseye' && (
        <>
          <circle r={NODE_R} fill="none" stroke={fill} strokeWidth={2.2} />
          <circle r={2.6} fill={fill} />
        </>
      )}
      {dot.shape === 'hollow' && (
        <>
          <circle r={NODE_R - 0.5} fill="var(--dsw-specific-menu, #fff)" stroke={fill} strokeWidth={1.8} />
          {slashed && <line x1={-3.4} y1={3.4} x2={3.4} y2={-3.4} stroke={fill} strokeWidth={1.4} strokeLinecap="round" />}
        </>
      )}
      {dot.shape === 'diamond' && (
        <>
          <rect x={-5} y={-5} width={10} height={10} rx={1.5} transform="rotate(45)" fill={fill} />
          <path d="M -2.4 0 L 2.4 0" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" />
        </>
      )}
    </g>
  )
}

/**
 * The workflow diagram of one research line — the whole group as ONE self
 * contained SVG (the v2 HTML/SVG mix taught us: one coordinate system beats
 * two). Dashed gridlines set the rhythm, colored tabs name the rails, S
 * curves carry cross-claim inflow at the event's own time column, a dashed
 * arch loops a retraction back onto its retracted node, and each claim's
 * terminal status becomes a milestone tag with an arrow onto its rail.
 */
function WorkflowDiagram({ layout, selectedId, onSelect, t }: {
  readonly layout: LaneGroupGraph
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly t: ResearchT
}) {
  const width = Math.max(TAB_W + 28 + layout.colCount * COL_W + 132, 560)
  const height = AXIS_H + layout.laneCount * RAIL_H + 16
  const markerId = `arrow-${layout.key.replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg className={css.laneSvg} width={width} height={height} role="img" aria-label={layout.label ?? layout.key}>
      <defs>
        <marker id={markerId} viewBox="0 0 8 8" refX={6} refY={4} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M 0 0 L 8 4 L 0 8 z" fill="#8a919e" />
        </marker>
      </defs>
      {/* Dashed gridlines: one per rail, the reference diagram's rhythm. */}
      {layout.headers.map((header, lane) => (
        <line key={`grid-${header.claimKey}`} x1={0} x2={width} y1={railY(lane)} y2={railY(lane)} stroke="#e4e7ec" strokeDasharray="4 5" />
      ))}
      {/* Date axis: a tick + label at every first-of-date column. */}
      {layout.dots.filter(dot => dot.dateFirst).map(dot => (
        <g key={`tick-${dot.id}`}>
          <line x1={colX(dot.col)} x2={colX(dot.col)} y1={AXIS_H - 6} y2={height - 8} stroke="#eef1f5" strokeWidth={1.5} />
          <text x={colX(dot.col) + 4} y={AXIS_H - 12} fontSize={10} fill="#8a919e">{dot.dateLabel}</text>
        </g>
      ))}
      {/* Rails: from the tab's right edge to the rail's last node. */}
      {layout.spans.map(span => (
        <line
          key={`rail-${span.lane}`}
          x1={TAB_W + 4} x2={colX(span.lastCol) + 26}
          y1={railY(span.lane)} y2={railY(span.lane)}
          stroke={LANE_PALETTE[span.lane % LANE_PALETTE.length]}
          strokeWidth={2} strokeLinecap="round" opacity={0.5}
        />
      ))}
      {/* Wires under the nodes. */}
      {layout.wires.map(wire => {
        const x1 = colX(wire.fromCol)
        const x2 = colX(wire.toCol)
        const y1 = railY(wire.fromLane)
        const y2 = railY(wire.toLane)
        if (wire.kind === 'retract') {
          // Dashed arch above the rail, arrowing back onto the retracted node.
          return (
            <path
              key={`retract-${wire.fromCol}-${wire.toCol}`}
              d={`M ${x2} ${y2 - 10} C ${x2 + 18} ${y2 - 26}, ${x1 + 18} ${y1 - 26}, ${x1} ${y1 - 10}`}
              fill="none" stroke="#8a919e" strokeWidth={1.5} strokeDasharray="4 3"
              markerEnd={`url(#${markerId})`}
            />
          )
        }
        const mid = (y1 + y2) / 2
        return (
          <path
            key={`cross-${wire.fromLane}-${wire.toLane}-${wire.fromCol}`}
            d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
            fill="none"
            stroke={LANE_PALETTE[wire.fromLane % LANE_PALETTE.length]}
            strokeWidth={2} opacity={0.85}
          />
        )
      })}
      {/* Claim tabs: the colored rail labels. */}
      {layout.headers.map((header, lane) => (
        <g key={header.claimKey}>
          <rect x={8} y={railY(lane) - 14} width={TAB_W} height={28} rx={7} fill={LANE_PALETTE[header.hue % LANE_PALETTE.length]} opacity={0.92} />
          <text x={18} y={railY(lane) + 4} fill="#fff" fontSize={11.5}>{shortLabel(header.label)}</text>
          {header.conflict && <circle cx={TAB_W - 10} cy={railY(lane)} r={4} fill="none" stroke="#fff" strokeWidth={1.6} />}
          <title>{header.label}</title>
        </g>
      ))}
      {/* Status milestone tags with a down-arrow onto the rail's head node. */}
      {layout.headers.filter(header => header.status !== null).map((header, lane) => {
        const tagX = colX(header.lastCol) + 30
        const tagY = railY(lane) - 31
        const fill = STATUS_FILL[header.status ?? ''] ?? '#8a919e'
        return (
          <g key={`tag-${header.claimKey}`}>
            <line x1={tagX + 22} y1={tagY + 18} x2={colX(header.lastCol) + 8} y2={railY(lane) - 10} stroke={fill} strokeWidth={1.2} />
            <rect x={tagX} y={tagY} width={44} height={18} rx={4} fill={fill} />
            <text x={tagX + 22} y={tagY + 13} textAnchor="middle" fill="#fff" fontSize={10.5}>{t(`evidence.tag.${header.status}` as ResearchKey)}</text>
          </g>
        )
      })}
      {/* Nodes: focusable SVG buttons (the list view remains the full a11y
          surface with every write affordance). */}
      {layout.dots.map(dot => {
        const label = `${dot.dateLabel} ${dot.timeLabel} · ${t(evidenceRelKey(dot.rel))} · ${dot.actorLabel}${dot.note !== null ? ` · ${dot.note}` : ''}`
        return (
          <g
            key={dot.id}
            className={css.laneNode}
            role="button"
            tabIndex={0}
            aria-label={label}
            onClick={() => { onSelect(dot.id === selectedId ? '' : dot.id) }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect(dot.id === selectedId ? '' : dot.id) }}
          >
            <title>{label}</title>
            <circle cx={colX(dot.col)} cy={railY(dot.lane)} r={13} fill="transparent" />
            <NodeGlyph dot={dot} selected={dot.id === selectedId} />
          </g>
        )
      })}
    </svg>
  )
}

/** The progressive-disclosure detail card of one selected node. */
function DotDetailCard({ dot, edge, onJump, onConfirm, onClose, t }: {
  readonly dot: LaneDot
  readonly edge: EvidenceGraphEdge | null
  readonly onJump: (ts: string) => void
  readonly onConfirm: (confirm: EvidenceRetractConfirm) => void
  readonly onClose: () => void
  readonly t: ResearchT
}) {
  const confirm = edge === null ? null : retractConfirmOf(edge)
  return (
    <div className={css.reportCard}>
      <div className={css.reportCardHead}>
        <h4 className={css.reportCardTitle}>
          <span className={css.tagPill} data-active={!dot.retracted || undefined} data-struck={dot.retracted || undefined}>
            {t(evidenceRelKey(dot.rel))}
          </span>
          <span className={css.actorBadge} data-hue={dot.actorHue}>{dot.actorLabel}</span>
          <span className={css.laneTime}>{dot.dateLabel} {dot.timeLabel}</span>
        </h4>
        <button type="button" className={css.retry} onClick={onClose}>{t('evidence.retractCancel')}</button>
      </div>
      {edge !== null && (
        <p className={css.ledgerDetail}>
          <code className={css.ledgerAction}>{edge.src} → {edge.dst}</code>
        </p>
      )}
      {dot.note !== null && <p className={css.ledgerDetail} data-struck={dot.retracted || undefined}>{dot.note}</p>}
      {edge?.retracted && (
        <p className={css.ledgerDetail}>
          {t('evidence.retractedAt', { at: edge.retractedAt ?? '', reason: edge.retractReason ?? '' })}
        </p>
      )}
      <div className={css.viewActions}>
        <button type="button" className={css.retry} onClick={() => { onJump(dot.ts) }}>{t('evidence.provenance')}</button>
        {confirm !== null && (
          <button type="button" className={css.btn} onClick={() => { onConfirm(confirm) }}>{t('evidence.retract')}</button>
        )}
      </div>
    </div>
  )
}

/** The graph rendering of one timeline group: title + the workflow SVG. */
function LaneGroupBlock({ layout, selectedId, onSelect, t }: {
  readonly layout: LaneGroupGraph
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
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
      <div className={css.laneGraph}>
        <WorkflowDiagram layout={layout} selectedId={selectedId} onSelect={onSelect} t={t} />
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
  // The selected node id (progressive disclosure: the diagram carries
  // structure only, details open in the card below).
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const view = evidence.view
  const laneGroups = useMemo(
    () => (view === null ? [] : buildLaneGroups(view.graph.timeline, view.graph.edges, view.graph.conflicts)),
    [view],
  )
  const selectedDot = selectedId === null ? null : laneGroups.flatMap(group => group.dots).find(dot => dot.id === selectedId) ?? null
  const selectedEdge = selectedDot === null || view === null
    ? null
    : view.graph.edges.find(edge => edge.sourceEventId === selectedDot.id) ?? null

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
            ? (
              <>
                {laneGroups.map(group => (
                  <LaneGroupBlock
                    key={group.key}
                    layout={group}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    t={t}
                  />
                ))}
                {selectedDot !== null && (
                  <DotDetailCard
                    dot={selectedDot}
                    edge={selectedEdge}
                    onJump={jumpToProvenance}
                    onConfirm={confirm => { setConfirming(confirm); setSelectedId(null) }}
                    onClose={() => { setSelectedId(null) }}
                    t={t}
                  />
                )}
              </>
            )
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
