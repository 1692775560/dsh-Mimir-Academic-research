/**
 * The servers view: a card grid of the remembered compute servers — name,
 * `user@host:port`, note, a probe-status dot with latency and relative check
 * time, and the GPU table (per-GPU utilization and memory bars) — plus an
 * inline add/edit form card. Opening the view loads the list once and probes
 * every server once; probes are repeatable per card or for the whole list.
 * @module dsh-client-ui-mimir/client/ServersView
 */

import { useEffect, useState } from 'react'
import type { ExperimentRecord, ServerInput, ServerView } from 'dsh-mimir/types'
import type {
  ResearchFailureView, ResearchJobsView, ResearchProjectSlice, ResearchServersView, ServerCheckState,
} from './controller.ts'
import { collectServerTags, failureCopy, filterServers, PROBE_FAILURE_KEYS, PROBE_STAGE_KEYS, probeStageOf, relativeTime, type ResearchT } from './view-common.ts'
import { EMPTY_SERVER_FORM, serverFormOf, serverInputOf, type ServerFormState } from './server-form.ts'
import { EmptyState } from './EmptyState.tsx'
import { ViewHead } from './ViewHead.tsx'
import { JobsSection } from './JobsSection.tsx'
import css from './ResearchPanel.module.css'

/** The status-dot data-state of one server's probe lifecycle. */
function dotStateOf(check: ServerCheckState | undefined): string {
  if (check === undefined) return 'unknown'
  if (check === 'checking') return 'checking'
  return check.state
}

/**
 * The in-flight probe's staged progress line. The host reports the stage only
 * once the probe settles, so while it runs the label is inferred from the
 * elapsed time and the probe's per-stage budgets (TCP 4s → SSH 5s → GPU
 * readout), with a worst-case ETA hint. The interval only ticks while this
 * line is mounted (i.e. while the card's probe is in flight).
 */
function ProbeProgressLine({ t }: { readonly t: ResearchT }) {
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const timer = setInterval(() => { setElapsedMs(Date.now() - startedAt) }, 250)
    return () => { clearInterval(timer) }
  }, [])
  return (
    <>
      <span className={css.serverProbeStage} role="status">{t(PROBE_STAGE_KEYS[probeStageOf(elapsedMs)])}</span>
      <span className={css.serverProbeEta}>{t('servers.probe.eta')}</span>
    </>
  )
}

/**
 * @param props - the servers slice, the per-server probe states, the
 * ensure/save/delete/check verbs, the jobs slice with its verbs (the remote
 * jobs section), the selected project's experiments slice (the job form's
 * link options), and copy.
 * @returns the server card grid plus the inline form card and the jobs
 * section.
 */
export function ServersView({
  servers, checks, ensureServers, saveServer, deleteServer, checkServer, checkAllServers,
  jobs, experiments, ensureJobs, refreshJobs, submitJob, deleteJob, t,
}: {
  readonly servers: ResearchServersView
  readonly checks: Readonly<Record<string, ServerCheckState>>
  readonly ensureServers: () => void
  readonly saveServer: (server: ServerInput) => Promise<ResearchFailureView | null>
  readonly deleteServer: (id: string) => Promise<ResearchFailureView | null>
  readonly checkServer: (id: string) => Promise<void>
  readonly checkAllServers: () => void
  readonly jobs: ResearchJobsView
  readonly experiments: ResearchProjectSlice<readonly ExperimentRecord[]> | null
  readonly ensureJobs: () => void
  readonly refreshJobs: () => void
  readonly submitJob: (serverId: string, command: string, experimentId?: string) => Promise<ResearchFailureView | null>
  readonly deleteJob: (id: string) => Promise<ResearchFailureView | null>
  readonly t: ResearchT
}) {
  /** 'new' for the add form, a server id for the edit form, null when closed. */
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [form, setForm] = useState<ServerFormState>(EMPTY_SERVER_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [tagInput, setTagInput] = useState('')
  /** The edit form's explicit clear-the-stored-password checkbox (#263). */
  const [clearPassword, setClearPassword] = useState(false)
  /** The card whose probe-failure line is expanded; null collapses them all. */
  const [openMessageId, setOpenMessageId] = useState<string | null>(null)

  // The view mounts only while its tab is active: load the list once, then
  // probe every listed server exactly once (a settled or in-flight probe
  // occupies the id's slot, so the effect never re-fires it).
  useEffect(() => { ensureServers() }, [ensureServers])
  useEffect(() => {
    if (servers.status !== 'ready') return
    for (const server of servers.list) {
      if (checks[server.id] === undefined) void checkServer(server.id)
    }
  }, [servers, checks, checkServer])

  const openAdd = (): void => {
    setEditing('new')
    setForm(EMPTY_SERVER_FORM)
    setFormError(null)
    setTagInput('')
    setClearPassword(false)
  }
  const openEdit = (record: ServerView): void => {
    setEditing(record.id)
    setForm(serverFormOf(record))
    setFormError(null)
    setTagInput('')
    setClearPassword(false)
  }
  const patchForm = (patch: Partial<ServerFormState>): void => {
    setForm(current => ({ ...current, ...patch }))
  }
  const addTag = (): void => {
    const tag = tagInput.trim()
    if (tag === '') return
    patchForm({ tags: form.tags.includes(tag) ? form.tags : [...form.tags, tag] })
    setTagInput('')
  }
  const submit = (): void => {
    if (saving) return
    setSaving(true)
    setFormError(null)
    void saveServer(serverInputOf(form, tagInput, editing, clearPassword))
      .then((failure) => {
        if (failure !== null) {
          setFormError(failure.message)
          return
        }
        setEditing(null)
      })
      .finally(() => { setSaving(false) })
  }
  const removeServer = (record: ServerView): void => {
    if (!window.confirm(t('servers.confirmDelete'))) return
    void deleteServer(record.id).then((failure) => {
      setActionError(failure === null ? null : `${t('servers.deleteFailed')}：${failure.message}`)
    })
  }

  const editingRecord = editing === null || editing === 'new'
    ? undefined
    : servers.list.find(server => server.id === editing)
  const allTags = collectServerTags(servers.list)
  const visible = filterServers(servers.list, activeTag)

  return (
    <div className={css.servers}>
      <ViewHead title={t('tab.servers')} subtitle={t('view.servers.subtitle')}>
        <button type="button" className={css.btnPrimary} onClick={openAdd}>
          {t('servers.add')}
        </button>
        <button
          type="button"
          className={css.btn}
          disabled={servers.list.length === 0}
          onClick={checkAllServers}
        >
          {t('servers.checkAll')}
        </button>
      </ViewHead>
      {actionError !== null && (
        <p className={css.failure} role="alert">{actionError}</p>
      )}
      {editing !== null && (editing === 'new' || editingRecord !== undefined) && (
        <div className={css.serverForm}>
          <h3 className={css.sectionTitle}>
            {editing === 'new' ? t('servers.form.add') : t('servers.form.edit')}
          </h3>
          <div className={css.serverFormGrid}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('servers.form.name')}</span>
              <input
                className={css.input}
                value={form.name}
                placeholder={t('servers.form.namePlaceholder')}
                onChange={event => { patchForm({ name: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('servers.form.host')}</span>
              <input
                className={css.input}
                value={form.host}
                placeholder={t('servers.form.hostPlaceholder')}
                onChange={event => { patchForm({ host: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('servers.form.port')}</span>
              <input
                className={css.input}
                value={form.port}
                inputMode="numeric"
                onChange={event => { patchForm({ port: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('servers.form.username')}</span>
              <input
                className={css.input}
                value={form.username}
                placeholder={t('servers.form.usernamePlaceholder')}
                onChange={event => { patchForm({ username: event.target.value }) }}
              />
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('servers.form.password')}</span>
              <input
                className={css.input}
                type="password"
                autoComplete="new-password"
                value={form.password}
                placeholder={editingRecord?.hasPassword === true
                  ? t('servers.form.passwordKeepPlaceholder')
                  : t('servers.form.passwordPlaceholder')}
                onChange={event => { patchForm({ password: event.target.value }) }}
              />
            </label>
            {editingRecord?.hasPassword === true && (
              <label className={css.field} data-wide>
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={event => { setClearPassword(event.target.checked) }}
                />
                {' '}{t('servers.form.clearPassword')}
              </label>
            )}
            <label className={css.field} data-wide>
              <span className={css.fieldLabel}>{t('servers.form.note')}</span>
              <input
                className={css.input}
                value={form.note}
                placeholder={t('servers.form.notePlaceholder')}
                onChange={event => { patchForm({ note: event.target.value }) }}
              />
            </label>
            <div className={css.field} data-wide>
              <span className={css.fieldLabel}>{t('servers.form.tags')}</span>
              <div className={css.tagEditor}>
                {form.tags.map(tag => (
                  <span key={tag} className={css.tagPill} data-static>
                    {tag}
                    <button
                      type="button"
                      className={css.tagRemove}
                      aria-label={`${t('servers.removeTag')} ${tag}`}
                      onClick={() => { patchForm({ tags: form.tags.filter(item => item !== tag) }) }}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className={css.input}
                  value={tagInput}
                  placeholder={t('servers.form.tagInputPlaceholder')}
                  onChange={event => { setTagInput(event.target.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                      event.preventDefault()
                      addTag()
                    }
                  }}
                />
              </div>
            </div>
          </div>
          {formError !== null && (
            <p className={css.failure} role="alert">{formError}</p>
          )}
          <div className={css.serverFormActions}>
            <button type="button" className={css.btnPrimary} disabled={saving} onClick={submit}>
              {t('servers.form.save')}
            </button>
            <button type="button" className={css.btn} onClick={() => { setEditing(null) }}>
              {t('servers.form.cancel')}
            </button>
          </div>
        </div>
      )}
      {servers.status === 'ready' && allTags.length > 0 && (
        <div className={css.papersFilters}>
          {allTags.map(tag => (
            <button
              key={tag}
              type="button"
              className={css.tagPill}
              data-active={activeTag === tag || undefined}
              aria-pressed={activeTag === tag}
              onClick={() => { setActiveTag(prev => (prev === tag ? null : tag)) }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {servers.status === 'cold' || servers.status === 'loading' ? (
        <p className={css.hint}>{t('servers.loading')}</p>
      ) : servers.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.servers')}：{failureCopy(t, servers.failure)}
          <button type="button" className={css.btn} onClick={ensureServers}>
            {t('error.retry')}
          </button>
        </p>
      ) : servers.list.length === 0 ? (
        <EmptyState glyph="🖥️">{t('servers.empty')}</EmptyState>
      ) : visible.length === 0 ? (
        <p className={css.hint}>{t('servers.noMatch')}</p>
      ) : (
        <div className={css.serversGrid}>
          {visible.map((record) => {
            const check = checks[record.id]
            const checking = check === 'checking'
            const settled = check !== undefined && check !== 'checking' ? check : null
            return (
              <article key={record.id} className={css.serverCard}>
                <div className={css.serverCardHead}>
                  <span className={css.serverDot} data-state={dotStateOf(check)} aria-hidden />
                  <div className={css.serverCardTitle}>
                    <span className={css.serverName}>{record.name}</span>
                    <code className={css.serverAddress}>
                      {record.username === '' ? '' : `${record.username}@`}
                      {record.host}:{record.port}
                    </code>
                  </div>
                  <span className={css.serverState} data-state={dotStateOf(check)}>
                    {checking
                      ? t('servers.state.checking')
                      : settled === null
                        ? t('servers.state.unknown')
                        : settled.state === 'online' ? t('servers.state.online') : t('servers.state.offline')}
                  </span>
                </div>
                {record.note !== '' && <p className={css.serverNote}>{record.note}</p>}
                {record.tags.length > 0 && (
                  <p className={css.paperTags}>
                    {record.tags.map(tag => (
                      <button
                        key={tag}
                        type="button"
                        className={css.tagPill}
                        data-active={activeTag === tag || undefined}
                        aria-pressed={activeTag === tag}
                        onClick={() => { setActiveTag(prev => (prev === tag ? null : tag)) }}
                      >
                        {tag}
                      </button>
                    ))}
                  </p>
                )}
                <p className={css.serverProbe}>
                  {settled === null
                    ? checking ? <ProbeProgressLine t={t} /> : t('servers.neverChecked')
                    : (
                      <>
                        {settled.latencyMs !== null && <span>{settled.latencyMs} ms · </span>}
                        <span>{relativeTime(t, settled.checkedAt)}</span>
                      </>
                    )}
                </p>
                {settled !== null && settled.message !== null && (
                  /* The probe failure renders as a quiet one-line error row:
                     truncated by default, the title tooltip shows it on hover
                     and the click toggles the full text (aria-expanded). */
                  <button
                    type="button"
                    className={css.serverMessage}
                    data-open={openMessageId === record.id || undefined}
                    aria-expanded={openMessageId === record.id}
                    title={settled.message}
                    onClick={() => { setOpenMessageId(prev => (prev === record.id ? null : record.id)) }}
                  >
                    <span className={css.serverMessageText}>
                      {settled.stage !== undefined && (
                        <span className={css.serverProbeFailStage}>{t(PROBE_FAILURE_KEYS[settled.stage])}：</span>
                      )}
                      {settled.message}
                    </span>
                  </button>
                )}
                {settled !== null && settled.state === 'online' && (
                  settled.gpus.length === 0 ? (
                    <p className={css.hint}>{t('servers.noGpus')}</p>
                  ) : (
                    <div className={css.gpuList}>
                      {settled.gpus.map((gpu, index) => (
                        <div key={`${gpu.name}-${index}`} className={css.gpuRow}>
                          <span className={css.gpuName} title={gpu.name}>{gpu.name}</span>
                          <span className={css.gpuMetric}>
                            <span className={css.gpuBar}>
                              <span className={css.gpuBarFill} style={{ width: `${Math.min(100, Math.max(0, gpu.utilizationPct))}%` }} />
                            </span>
                            <span className={css.gpuValue}>{gpu.utilizationPct}%</span>
                          </span>
                          <span className={css.gpuMetric}>
                            <span className={css.gpuBar} data-kind="memory">
                              <span
                                className={css.gpuBarFill}
                                style={{
                                  width: gpu.memoryTotalMb > 0
                                    ? `${Math.min(100, (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100)}%`
                                    : '0%',
                                }}
                              />
                            </span>
                            <span className={css.gpuValue}>{gpu.memoryUsedMb}/{gpu.memoryTotalMb} MB</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )
                )}
                <div className={css.serverActions}>
                  <button
                    type="button"
                    className={css.btn}
                    disabled={checking}
                    onClick={() => { void checkServer(record.id) }}
                  >
                    {t('servers.check')}
                  </button>
                  <button type="button" className={css.btn} onClick={() => { openEdit(record) }}>
                    {t('servers.edit')}
                  </button>
                  <button type="button" className={css.btn} data-danger onClick={() => { removeServer(record) }}>
                    {t('servers.delete')}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
      <JobsSection
        jobs={jobs}
        servers={servers}
        experiments={experiments}
        ensureJobs={ensureJobs}
        refreshJobs={refreshJobs}
        submitJob={submitJob}
        deleteJob={deleteJob}
        t={t}
      />
    </div>
  )
}
