/**
 * The experiments view's inline create/edit form: a card under the toolbar
 * with the name (required), the status select, the metrics key/value row
 * editor (dynamic rows, values that fully parse as numbers are stored as
 * numbers — see `experiment-form.ts`), an optional linked-server select,
 * and save/cancel. Saving goes through the `saveExperiment` verb; the
 * controller patches the loaded slice and toasts, the form only surfaces a
 * rejection and closes on success.
 * @module dsh-client-ui-mimir/client/ExperimentForm
 */

import { useState } from 'react'
import type { ExperimentInput, ExperimentRecord, ExperimentStatus, MetricDirection } from 'dsh-mimir/types'
import type { ResearchFailureView, ResearchServersView } from './controller.ts'
import {
  directionsFromRows,
  metricRowsFromMetrics,
  metricsFromRows,
  type MetricRow,
} from './experiment-form.ts'
import type { ResearchT } from './view-common.ts'
import css from './ResearchPanel.module.css'

/** Status options of the select, in lifecycle order. */
const STATUSES: readonly ExperimentStatus[] = ['running', 'success', 'failed']

/** Direction options of each metric row's select (#220), in declaration order. */
const DIRECTIONS: readonly MetricDirection[] = ['none', 'min', 'max']

/**
 * @param props - the owning project, the record being edited (null =
 * create), the servers slice (the link select's options), the save verb,
 * the close callback, and copy.
 * @returns the form card.
 */
export function ExperimentForm({ projectId, editing, servers, saveExperiment, onClose, t }: {
  readonly projectId: string
  readonly editing: ExperimentRecord | null
  readonly servers: ResearchServersView
  readonly saveExperiment: (experiment: ExperimentInput) => Promise<ResearchFailureView | null>
  readonly onClose: () => void
  readonly t: ResearchT
}) {
  const [name, setName] = useState(editing?.name ?? '')
  const [status, setStatus] = useState<ExperimentStatus>(editing?.status ?? 'running')
  const [rows, setRows] = useState<MetricRow[]>(() =>
    editing === null ? [] : metricRowsFromMetrics(editing.metrics, editing.metricDirections))
  const [serverId, setServerId] = useState(editing?.serverId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const patchRow = (index: number, patch: Partial<MetricRow>): void => {
    setRows(prev => prev.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  const save = (): void => {
    if (name.trim().length === 0) {
      setError(t('experiments.nameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    void saveExperiment({
      id: editing?.id,
      projectId,
      name: name.trim(),
      status,
      metrics: metricsFromRows(rows),
      metricDirections: directionsFromRows(rows),
      serverId: serverId === '' ? undefined : serverId,
    }).then((failure) => {
      setBusy(false)
      if (failure !== null) {
        setError(`${t('experiments.saveFailed')}：${failure.message}`)
        return
      }
      onClose()
    })
  }

  return (
    <div className={css.serverForm}>
      <h3 className={css.sectionTitle}>
        {editing === null ? t('experiments.formNew') : t('experiments.formEdit')}
      </h3>
      <div className={css.serverFormGrid}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('experiments.fieldName')}</span>
          <input
            className={css.input}
            value={name}
            onChange={event => { setName(event.target.value); setError(null) }}
          />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('experiments.fieldStatus')}</span>
          <select
            className={css.input}
            value={status}
            onChange={event => { setStatus(event.target.value as ExperimentStatus) }}
          >
            {STATUSES.map(option => (
              <option key={option} value={option}>{t(`experimentStatus.${option}`)}</option>
            ))}
          </select>
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('experiments.fieldServer')}</span>
          <select
            className={css.input}
            value={serverId}
            onChange={event => { setServerId(event.target.value) }}
          >
            <option value="">{t('experiments.noServer')}</option>
            {servers.status === 'ready' && servers.list.map(server => (
              <option key={server.id} value={server.id}>{server.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('experiments.fieldMetrics')}</span>
        <div className={css.metricRows}>
          {rows.map((row, index) => (
            <div key={index} className={css.metricRow}>
              <input
                className={css.input}
                value={row.key}
                placeholder={t('experiments.metricKey')}
                onChange={event => { patchRow(index, { key: event.target.value }) }}
              />
              <input
                className={css.input}
                value={row.value}
                placeholder={t('experiments.metricValue')}
                onChange={event => { patchRow(index, { value: event.target.value }) }}
              />
              <select
                className={css.input}
                aria-label={t('experiments.direction')}
                value={row.direction}
                onChange={event => { patchRow(index, { direction: event.target.value as MetricDirection }) }}
              >
                {DIRECTIONS.map(option => (
                  <option key={option} value={option}>{t(`metricDirection.${option}`)}</option>
                ))}
              </select>
              <button
                type="button"
                className={css.btn}
                aria-label={t('experiments.removeMetricRow')}
                onClick={() => { setRows(prev => prev.filter((_, at) => at !== index)) }}
              >
                ×
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className={css.btn}
              onClick={() => { setRows(prev => [...prev, { key: '', value: '', direction: 'none' }]) }}
            >
              {t('experiments.addMetricRow')}
            </button>
          </div>
        </div>
      </div>
      {error !== null && <p className={css.failure} role="alert">{error}</p>}
      <div className={css.serverFormActions}>
        <button type="button" className={css.btnPrimary} disabled={busy} onClick={save}>
          {t('experiments.save')}
        </button>
        <button type="button" className={css.btn} disabled={busy} onClick={onClose}>
          {t('experiments.cancel')}
        </button>
      </div>
    </div>
  )
}
