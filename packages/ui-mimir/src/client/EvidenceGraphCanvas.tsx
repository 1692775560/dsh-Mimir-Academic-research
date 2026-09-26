/**
 * Evidence Graph canvas (PRD §12/§138): the presentational SVG renderer. It
 * draws an already-computed `EvidenceGraphLayout` — it performs NO geometry
 * calculation, owns NO domain data, and calls NO remote (§139). Paint order
 * follows PRD §41 (background → labels → ticks → rails → edges → nodes →
 * labels → hit targets), every node carries a transparent ≥28px hit target
 * (§50) and keyboard affordances (§51).
 * @module dsh-client-ui-mimir/client/EvidenceGraphCanvas
 */

import type {
  EvidenceGraphLayout,
  EvidenceLinkLayout,
  EvidenceNodeLayout,
  EvidenceRailLayout,
} from './evidence-graph-layout.ts'
import { clipLabel } from './evidence-graph-layout.ts'
import type { ResearchKey } from './locales.ts'
import type { ResearchT } from './view-common.ts'
import css from './EvidenceGraph.module.css'

/** One relation glyph inside a bead: shape carries the semantics (§7.4). */
function RelationGlyph({ relClass }: { readonly relClass: string | null }) {
  if (relClass === 'supports') return <path d="M -2.6 0 L -0.8 1.9 L 3 -2" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
  if (relClass === 'contradicts') return <path d="M -2.2 -2.2 L 2.2 2.2 M 2.2 -2.2 L -2.2 2.2" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" />
  if (relClass === 'tests') return <circle r={2.2} fill="#fff" />
  if (relClass === 'retract') return <path d="M -2 0 L 2 0" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" />
  return null
}

/** One circular node + its semantic treatment (§7.2/§21/§22/§79). */
function EvidenceNode({ node, selected, onSelect, t }: {
  readonly node: EvidenceNodeLayout
  readonly selected: boolean
  readonly onSelect: (id: string) => void
  readonly t: ResearchT
}) {
  const label = node.label
  const select = (): void => { onSelect(node.id) }
  return (
    <g
      className={css.evidenceNode}
      data-kind={node.kind}
      data-lane={node.hue}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={select}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select() } }}
    >
      <title>{label}</title>
      <circle className={css.evidenceNodeHit} cx={node.x} cy={node.y} r={14} />
      {selected && <circle className={css.evidenceNodeSelection} cx={node.x} cy={node.y} r={node.r + 5} />}
      {node.kind === 'event' || node.kind === 'retract' ? (
        <g transform={`translate(${node.x} ${node.y})`}>
          {node.conflict && <circle className={css.evidenceConflictRing} r={node.r + 4} />}
          {node.retracted && <circle className={css.evidenceBeadRetracted} r={node.r} />}
          {node.kind === 'event' && !node.retracted && <circle className={css.evidenceBead} r={node.r} />}
          {node.kind === 'retract' && <rect className={css.evidenceRetract} x={-5} y={-5} width={10} height={10} rx={1.5} transform="rotate(45)" />}
          {!node.retracted && node.kind === 'event' && <RelationGlyph relClass={node.relClass} />}
          {node.kind === 'retract' && <path d="M -2 0 L 2 0" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" />}
        </g>
      ) : null}
      {node.kind === 'claim' && (
        <g transform={`translate(${node.x} ${node.y})`}>
          <circle className={css.evidenceClaimRing} r={node.r} />
          <circle className={css.evidenceClaimCore} r={node.r - 3.5} />
          {node.status !== null && (
            <g transform={`translate(${node.r + 4} ${-node.r - 2})`}>
              <rect className={css.evidenceStatusTag} data-status={node.status} x={0} y={0} width={46} height={16} rx={4} />
              <text className={css.evidenceStatusText} x={23} y={12} textAnchor="middle">{t(`evidence.tag.${node.status}` as ResearchKey)}</text>
            </g>
          )}
        </g>
      )}
      {node.kind === 'eureka' && (
        <g transform={`translate(${node.x} ${node.y})`}>
          <circle className={css.evidenceEurekaRing} r={node.r + 3} />
          <circle className={css.evidenceEurekaCore} r={node.r} />
          <text className={css.evidenceEurekaLabel} x={node.r + 4} y={4}>{clipLabel(node.label, 22)}</text>
        </g>
      )}
      {node.kind === 'source' && (
        <g transform={`translate(${node.x} ${node.y})`}>
          <circle className={css.evidenceSource} r={node.r} />
        </g>
      )}
    </g>
  )
}

/** One routed link path (§40 perimeter-trimmed; §41 subdued-first order). */
function EvidenceLink({ link }: { readonly link: EvidenceLinkLayout }) {
  return (
    <path
      className={css.evidenceLink}
      data-kind={link.kind}
      data-lane={link.hue ?? 0}
      d={link.d}
      aria-hidden
    />
  )
}

/**
 * The temporal research map: bands, rails, nodes, and links, rendered from a
 * deterministic layout. The component is presentational — selection and
 * copy are the only interaction surface.
 */
export function EvidenceGraphCanvas({ layout, selectedId, onSelect, t }: {
  readonly layout: EvidenceGraphLayout
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly t: ResearchT
}) {
  const tickHeight = layout.height - 8
  return (
    <svg
      className={css.graphSvg}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
      height={layout.height}
      role="img"
      aria-label="evidence graph"
    >
      {/* Time axis ticks (subdued, behind everything). */}
      {layout.ticks.map(tick => (
        <g key={tick.label}>
          <line className={css.evidenceTickLine} x1={tick.x} x2={tick.x} y1={40} y2={tickHeight} />
          <text className={css.evidenceTickLabel} x={tick.x + 4} y={26}>{tick.label}</text>
        </g>
      ))}

      {/* Band labels + rails (lane guides). */}
      {layout.bands.map(band => (
        <g key={band.key}>
          <text className={css.evidenceBandLabel} data-lane={band.hue} x={12} y={band.y + 22}>
            {clipLabel(band.label ?? band.key, 20)}
          </text>
        </g>
      ))}
      {layout.rails.map(rail => <RailLine key={rail.claimKey} rail={rail} />)}

      {/* Links: subdued (retract/conflict) before normal (inflow/external). */}
      {layout.links.filter(link => link.kind === 'retract' || link.kind === 'conflict').map(link => (
        <EvidenceLink key={`${link.kind}-${link.fromId}-${link.toId}`} link={link} />
      ))}
      {layout.links.filter(link => link.kind === 'inflow' || link.kind === 'external').map(link => (
        <EvidenceLink key={`${link.kind}-${link.fromId}-${link.toId}`} link={link} />
      ))}

      {/* Nodes (hit targets render last, visually transparent). */}
      {layout.nodes.map(node => (
        <EvidenceNode key={node.id} node={node} selected={node.id === selectedId} onSelect={onSelect} t={t} />
      ))}
    </svg>
  )
}

/** One claim rail: the horizontal branch guide + its label. */
function RailLine({ rail }: { readonly rail: EvidenceRailLayout }) {
  return (
    <g>
      <text className={css.evidenceRailLabel} x={34} y={rail.y + 4}>
        {clipLabel(rail.label, 26)}
      </text>
      <line className={css.evidenceRail} data-lane={rail.hue} x1={rail.x1} x2={rail.x2} y1={rail.y} y2={rail.y} />
    </g>
  )
}
