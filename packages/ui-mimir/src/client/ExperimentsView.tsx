/**
 * The experiments view: the selected project's experiment-run table (status
 * pill, expandable metrics, the linked-server badge with an inline relink
 * dropdown, edit/delete actions) topped by the inline create/edit form
 * (`ExperimentForm.tsx`, opened from the toolbar's new-experiment button or
 * a row's edit) and a metric-comparison section — one
 * hand-drawn inline SVG bar chart per numeric metric key shared by at least
 * two runs — above the whitelisted `EXPERIMENT_LOG.md` artifact, rendered by
 * the restricted Markdown renderer in `MarkdownView.tsx` (dependency-free).
 * @module dsh-client-ui-mimir/client/ExperimentsView
 */

import { useEffect, useState } from 'react'
import type { ExperimentInput, ExperimentRecord, MetricDirection } from 'dsh-mimir/types'
import type {
  ResearchArtifactView, ResearchFailureView, ResearchProjectSlice, ResearchServersView,
} from './controller.ts'
import {
  barSpans,
  bestRowIndex,
  zeroLinePct,
  chartNameLines,
  failureCopy,
  formatDurationMs,
  formatMetricValue,
  metricChartRows,
  metricDirectionsOf,
  numericMetricKeys,
  relativeTime,
  type MetricChartRow,
  type ResearchT,
} from './view-common.ts'
import { renderMarkdown } from './MarkdownView.tsx'
import { EmptyState } from './EmptyState.tsx'
import { ExperimentForm } from './ExperimentForm.tsx'
import { ViewHead } from './ViewHead.tsx'
import css from './ResearchPanel.module.css'

/** Bar-chart geometry: bars span x 132–268 of the 340-wide viewBox. */
const CHART_WIDTH = 340
const CHART_BAR_X = 132
const CHART_BAR_MAX_WIDTH = 136
const CHART_ROW_HEIGHT = 26

/**
 * One metric's comparison chart: one horizontal bar per run carrying a finite
 * value for the key, oldest run on top, bars on a zero baseline so negatives
 * extend left (#220). The best run under the metric's direction is shaded.
 * Run names wrap to two lines via `chartNameLines`. Pure inline SVG —
 * no charting dependency.
 */
function MetricChart({ metricKey, rows, direction, generateLabel, generating, onGenerate }: {
  readonly metricKey: string
  readonly rows: readonly MetricChartRow[]
  /** The metric's preference direction (#220); `none` highlights nothing. */
  readonly direction: MetricDirection
  /** Localized "generate paper figure" button copy. */
  readonly generateLabel: string
  /** Whether this chart's generate request is in flight. */
  readonly generating: boolean
  /** The per-chart "generate paper figure" button. */
  readonly onGenerate: () => void
}) {
  const spans = barSpans(rows.map(row => row.value))
  const zeroPct = zeroLinePct(rows.map(row => row.value))
  const best = bestRowIndex(rows, direction)
  const height = rows.length * CHART_ROW_HEIGHT + 4
  return (
    <div className={css.metricChart}>
      <div className={css.metricChartHead}>
        <h4 title={metricKey}>{metricKey}</h4>
        <button type="button" className={css.retry} disabled={generating} onClick={onGenerate}>
          {generateLabel}
        </button>
      </div>
      <svg
        className={css.metricChartSvg}
        viewBox={`0 0 ${String(CHART_WIDTH)} ${String(height)}`}
        role="img"
        aria-label={metricKey}
      >
        {zeroPct !== null && (
          <line
            className={css.metricZeroLine}
            x1={CHART_BAR_X + (zeroPct / 100) * CHART_BAR_MAX_WIDTH}
            y1={0}
            x2={CHART_BAR_X + (zeroPct / 100) * CHART_BAR_MAX_WIDTH}
            y2={height}
          />
        )}
        {rows.map((row, index) => {
          const y = 2 + index * CHART_ROW_HEIGHT
          const span = spans[index] ?? { leftPct: 0, widthPct: 0, negative: false }
          // Long run names wrap to a second line instead of ellipsizing early;
          // the full name rides the <title> tooltip either way.
          const [nameFirst, nameSecond] = chartNameLines(row.name)
          return (
            <g key={row.id}>
              <text className={css.metricName} x={0} y={nameSecond === undefined ? y + 15 : y + 10}>
                <title>{row.name}</title>
                {nameFirst}
              </text>
              {nameSecond !== undefined && (
                <text className={css.metricName} x={0} y={y + 21}>{nameSecond}</text>
              )}
              <rect
                className={css.metricBar}
                data-status={row.status}
                data-negative={span.negative || undefined}
                data-best={best === index || undefined}
                x={CHART_BAR_X + (span.leftPct / 100) * CHART_BAR_MAX_WIDTH}
                y={y + 4}
                width={(span.widthPct / 100) * CHART_BAR_MAX_WIDTH}
                height={14}
                rx={4}
              />
              <text className={css.metricValue} x={CHART_BAR_X + CHART_BAR_MAX_WIDTH + 6} y={y + 15}>
                {formatMetricValue(row.value)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/**
 * @param props - the experiments slice, the artifact view, the servers slice
 * (the relink dropdown's options), the selected project id, the verbs, and
 * copy.
 * @returns the metric charts, the experiment table, and the log viewer.
 */
export function ExperimentsView({
  experiments, artifact, servers, projectId, ensureServers, deleteExperiment, updateExperiment,
  saveExperiment, generateMetricFigure, retry, t,
}: {
  readonly experiments: ResearchProjectSlice<readonly ExperimentRecord[]> | null
  readonly artifact: ResearchArtifactView | null
  readonly servers: ResearchServersView
  readonly projectId: string | null
  readonly ensureServers: () => void
  readonly deleteExperiment: (id: string) => Promise<ResearchFailureView | null>
  readonly updateExperiment: (id: string, serverId: string | null) => Promise<ResearchFailureView | null>
  readonly saveExperiment: (experiment: ExperimentInput) => Promise<ResearchFailureView | null>
  /** The per-chart "generate paper figure" button (failures ride toasts). */
  readonly generateMetricFigure: (metricKey: string, rows: readonly MetricChartRow[], direction: MetricDirection) => Promise<void>
  /** Reload the slice after a load failure (re-selects the current project). */
  readonly retry: () => void
  readonly t: ResearchT
}) {
  const [openMetrics, setOpenMetrics] = useState<Record<string, boolean>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  // The metric key whose paper-figure generation is in flight (double-click guard).
  const [generatingKey, setGeneratingKey] = useState<string | null>(null)
  // The inline create/edit form; `editing` null means create.
  const [form, setForm] = useState<{ editing: ExperimentRecord | null } | null>(null)
  // The relink dropdown needs the server list; load it once per view mount.
  useEffect(() => { ensureServers() }, [ensureServers])
  const removeExperiment = (record: ExperimentRecord): void => {
    if (!window.confirm(t('experiments.confirmDelete'))) return
    void deleteExperiment(record.id).then((failure) => {
      setActionError(failure === null ? null : `${t('experiments.deleteFailed')}：${failure.message}`)
    })
  }
  const relink = (id: string, serverId: string | null): void => {
    void updateExperiment(id, serverId).then((failure) => {
      setActionError(failure === null ? null : `${t('experiments.linkFailed')}：${failure.message}`)
    })
  }
  /** Display name of one linked server; unknown ids show raw. */
  const serverNameOf = (id: string): string =>
    servers.status === 'ready' ? servers.list.find(server => server.id === id)?.name ?? id : id
  const chartKeys = experiments !== null && experiments.status === 'ready'
    ? numericMetricKeys(experiments.list)
    : []
  // Per-metric preference directions (#220), merged across the project's
  // runs (newest record wins) — they drive the best-run shading and ride
  // the exported SVG figure.
  const chartDirections = experiments !== null && experiments.status === 'ready'
    ? metricDirectionsOf(experiments.list)
    : {}
  return (
    <div className={css.experiments}>
      <ViewHead title={t('tab.experiments')} subtitle={t('view.experiments.subtitle')} />
      {projectId !== null && (
        <div className={css.dataActions}>
          <button
            type="button"
            className={css.btnPrimary}
            disabled={form !== null}
            onClick={() => { setForm({ editing: null }) }}
          >
            {t('experiments.add')}
          </button>
        </div>
      )}
      {form !== null && projectId !== null && (
        <ExperimentForm
          key={form.editing?.id ?? 'new'}
          projectId={projectId}
          editing={form.editing}
          servers={servers}
          saveExperiment={saveExperiment}
          onClose={() => { setForm(null) }}
          t={t}
        />
      )}
      {experiments === null || experiments.status === 'loading' ? (
        <p className={css.hint}>{t('experiments.loading')}</p>
      ) : experiments.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.experiments')}：{failureCopy(t, experiments.failure)}
          <button type="button" className={css.retry} onClick={retry}>
            {t('projects.retry')}
          </button>
        </p>
      ) : experiments.list.length === 0 ? (
        <EmptyState glyph="🧪">{t('experiments.empty')}</EmptyState>
      ) : (
        <>
          {chartKeys.length > 0 && (
            <div className={css.metricCharts}>
              <h3 className={css.sectionTitle}>{t('experiments.compare')}</h3>
              <div className={css.metricChartGrid}>
                {chartKeys.map((key) => {
                  const rows = metricChartRows(experiments.list, key)
                  const direction = chartDirections[key] ?? 'none'
                  return (
                    <MetricChart
                      key={key}
                      metricKey={key}
                      rows={rows}
                      direction={direction}
                      generateLabel={t('experiments.genFigure')}
                      generating={generatingKey === key}
                      onGenerate={() => {
                        setGeneratingKey(key)
                        void generateMetricFigure(key, rows, direction).finally(() => { setGeneratingKey(null) })
                      }}
                    />
                  )
                })}
              </div>
            </div>
          )}
          {actionError !== null && <p className={css.failure} role="alert">{actionError}</p>}
          <div className={css.experimentTableWrap}>
            <h3 className={css.sectionTitle}>{t('experiments.title')}</h3>
            <table className={css.experimentTable}>
              <thead>
                <tr>
                  <th>{t('experiments.colName')}</th>
                  <th>{t('experiments.colStatus')}</th>
                  <th>{t('experiments.colMetrics')}</th>
                  <th>{t('experiments.colServer')}</th>
                  <th>{t('experiments.colUpdated')}</th>
                  <th>{t('experiments.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {experiments.list.map((record) => {
                  const entries = Object.entries(record.metrics)
                  const open = Boolean(openMetrics[record.id])
                  return (
                    <tr key={record.id}>
                      <td>{record.name}</td>
                      <td>
                        <span className={css.experimentStatus} data-status={record.status}>
                          {t(`experimentStatus.${record.status}`)}
                        </span>
                        {record.lastJob !== undefined && (
                          <span
                            className={css.experimentLastJob}
                            title={record.lastJob.summary !== '' ? record.lastJob.summary : undefined}
                          >
                            {t('experiments.lastJob')}
                            <span className={css.jobStatus} data-status={record.lastJob.status}>
                              {t(`jobStatus.${record.lastJob.status}`)}
                            </span>
                            {record.lastJob.durationMs !== null && (
                              <span>{formatDurationMs(record.lastJob.durationMs)}</span>
                            )}
                            <span>{relativeTime(t, record.lastJob.finishedAt)}</span>
                          </span>
                        )}
                      </td>
                      <td>
                        {entries.length > 0 && (
                          <button
                            type="button"
                            className={css.metricsToggle}
                            aria-expanded={open}
                            onClick={() => {
                              setOpenMetrics(prev => ({ ...prev, [record.id]: !prev[record.id] }))
                            }}
                          >
                            {entries.length} {t('experiments.metrics')}
                          </button>
                        )}
                        {open && (
                          <dl className={css.metricsList}>
                            {entries.map(([key, value]) => (
                              <div key={key} className={css.metricsRow}>
                                <dt>{key}</dt>
                                <dd>{formatMetricValue(value)}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </td>
                      <td>
                        {record.serverId !== undefined && (
                          <span className={css.serverBadge}>⚡ {serverNameOf(record.serverId)}</span>
                        )}
                        <select
                          className={css.serverSelect}
                          value={record.serverId ?? ''}
                          aria-label={t('experiments.linkServer')}
                          onChange={(event) => {
                            relink(record.id, event.target.value === '' ? null : event.target.value)
                          }}
                        >
                          <option value="">{t('experiments.noServer')}</option>
                          {servers.status === 'ready' && servers.list.map(server => (
                            <option key={server.id} value={server.id}>{server.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>{record.updatedAt.slice(0, 16).replace('T', ' ')}</td>
                      <td>
                        <button
                          type="button"
                          className={css.btn}
                          onClick={() => { setForm({ editing: record }) }}
                        >
                          {t('experiments.edit')}
                        </button>
                        <button
                          type="button"
                          className={css.btn}
                          data-danger
                          onClick={() => { removeExperiment(record) }}
                        >
                          {t('experiments.delete')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {projectId === null || artifact === null || artifact.status === 'loading' ? (
        <p className={css.hint}>{t('experiments.loading')}</p>
      ) : artifact.status === 'error' ? (
        artifact.failure?.code === 'artifact-not-found' ? (
          <EmptyState glyph="🗒️">{t('experiments.noLog')}</EmptyState>
        ) : (
          <p className={css.failure} role="alert">
            {t('error.experiments')}：{failureCopy(t, artifact.failure)}
          </p>
        )
      ) : (
        <div className={css.experimentLog}>
          <h3 className={css.sectionTitle}>{t('experiments.log')}</h3>
          {renderMarkdown(artifact.content)}
        </div>
      )}
    </div>
  )
}
