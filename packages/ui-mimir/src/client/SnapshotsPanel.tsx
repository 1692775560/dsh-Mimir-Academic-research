/**
 * The paper snapshots panel: the selected project's compile snapshots as a
 * newest-first list (relative time, file count, total size), each row
 * expandable to a line diff against the current source (long unchanged runs
 * folded into gap markers, so a large paper never mounts one row per line)
 * and revertible under a two-step inline confirm. The panel replaces the
 * paper view's PDF preview while open; the revert rides the host's
 * optimistic-concurrency write, so a file the agent touched mid-review
 * rejects with a conflict instead of silently overwriting.
 * @module dsh-client-ui-mimir/client/SnapshotsPanel
 */

import { useEffect, useMemo, useState } from 'react'
import type { PaperSnapshotView } from 'dsh-mimir/types'
import type {
  ResearchFailureView, ResearchProjectSlice, ResearchSnapshotDetailView, ResearchSourceView,
} from './controller.ts'
import { collapseDiffRows, diffLines } from './snapshot-diff.ts'
import { failureCopy, formatSize, relativeTime, type ResearchT } from './view-common.ts'
import css from './ResearchPanel.module.css'

/**
 * The diff of one expanded snapshot against the current source.
 * @param props - the snapshot's fetched files, the current draft, the entry
 * filename (the diff's subject — #249), and copy.
 */
function SnapshotDiff({ detail, current, entryFile, t }: {
  readonly detail: ResearchSnapshotDetailView
  readonly current: string
  readonly entryFile: string
  readonly t: ResearchT
}) {
  const rows = useMemo(() => {
    const snapshotMain = detail.files.find(file => file.path === entryFile)
    return snapshotMain === undefined ? null : collapseDiffRows(diffLines(snapshotMain.content, current))
  }, [detail.files, current, entryFile])
  if (rows === null) return <p className={css.hint}>{t('snapshots.noMain', { file: entryFile })}</p>
  if (rows.every(row => row.type === 'same')) {
    return <p className={css.hint}>{t('snapshots.unchanged')}</p>
  }
  return (
    <div className={css.diffView} aria-label={t('snapshots.diffTitle')}>
      {rows.map((row, index) => row.type === 'gap' ? (
        <div key={`gap-${String(index)}`} className={css.diffGap}>
          {t('snapshots.gap', { count: row.count })}
        </div>
      ) : (
        <div key={`${row.type}-${String(index)}`} className={css.diffLine} data-type={row.type}>
          <span className={css.diffLineNo}>{row.type === 'add' ? row.newLine : row.oldLine}</span>
          <span className={css.diffSign} aria-hidden>
            {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
          </span>
          <span className={css.diffText}>{row.text}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * @param props - the snapshot list and detail slices, the current source (the
 * diff's other side and the revert's concurrency base), the verbs, and copy.
 * @returns the snapshots panel.
 */
export function SnapshotsPanel({
  snapshots, snapshotDetail, source, projectId, entryFile,
  loadSnapshots, loadSnapshotDetail, closeSnapshotDetail, revertSnapshot, onClose, t,
}: {
  readonly snapshots: ResearchProjectSlice<readonly PaperSnapshotView[]> | null
  readonly snapshotDetail: ResearchSnapshotDetailView | null
  readonly source: ResearchSourceView | null
  readonly projectId: string
  /** The project's entry .tex basename (the diff subject and revert anchor); defaults to `main.tex` (#249). */
  readonly entryFile?: string | undefined
  readonly loadSnapshots: (projectId: string, force?: boolean) => void
  readonly loadSnapshotDetail: (projectId: string, id: string) => void
  readonly closeSnapshotDetail: () => void
  readonly revertSnapshot: (projectId: string, id: string) => Promise<ResearchFailureView | null>
  readonly onClose: () => void
  readonly t: ResearchT
}) {
  // The row whose diff is expanded (one at a time), the row mid-confirm, and
  // the row whose revert is in flight.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [revertingId, setRevertingId] = useState<string | null>(null)
  // The last rejected action (diff load or revert), surfaced above the list.
  const [actionError, setActionError] = useState<string | null>(null)

  const current = snapshots !== null && snapshots.projectId === projectId ? snapshots : null

  useEffect(() => { loadSnapshots(projectId) }, [projectId, loadSnapshots])
  // Closing the panel (or switching projects, which remounts) drops the detail.
  useEffect(() => () => { closeSnapshotDetail() }, [closeSnapshotDetail])

  const toggleDiff = (id: string): void => {
    setActionError(null)
    setConfirmId(null)
    if (expandedId === id) {
      setExpandedId(null)
      closeSnapshotDetail()
      return
    }
    setExpandedId(id)
    loadSnapshotDetail(projectId, id)
  }

  const revert = (id: string): void => {
    if (revertingId !== null) return
    setRevertingId(id)
    setActionError(null)
    void revertSnapshot(projectId, id)
      .then((failure) => {
        if (failure === null) {
          setExpandedId(null)
          setConfirmId(null)
          closeSnapshotDetail()
        } else {
          setActionError(failure.code === 'conflict'
            ? t('snapshots.revertConflict')
            : `${t('snapshots.revertFailed')}：${failureCopy(t, failure)}`)
        }
      })
      .finally(() => { setRevertingId(null) })
  }

  const currentContent = source !== null && source.projectId === projectId && source.status === 'ready'
    ? source.content
    : null
  // A revert overwrites the file the draft edits; only a clean draft may go.
  const revertable = source !== null && source.projectId === projectId
    && source.status === 'ready'
    && (source.saveState === 'clean' || source.saveState === 'saved')
  const detail = snapshotDetail !== null
    && snapshotDetail.projectId === projectId && snapshotDetail.id === expandedId
    ? snapshotDetail
    : null

  return (
    <div className={css.bibPanel}>
      <div className={css.bibHead}>
        <h3 className={css.sectionTitle}>{t('snapshots.title')}</h3>
        <div className={css.bibHeadActions}>
          <button
            type="button"
            className={css.btn}
            disabled={current === null || current.status === 'loading'}
            onClick={() => { loadSnapshots(projectId, true) }}
          >
            {t('figures.refresh')}
          </button>
          <button type="button" className={css.btn} onClick={onClose}>
            {t('snapshots.close')}
          </button>
        </div>
      </div>
      {actionError !== null && (
        <p className={css.failure} role="alert">{actionError}</p>
      )}
      {current === null || current.status === 'loading' ? (
        <p className={css.hint}>{t('snapshots.loading')}</p>
      ) : current.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.snapshots')}：{failureCopy(t, current.failure)}
          <button type="button" className={css.btn} onClick={() => { loadSnapshots(projectId, true) }}>
            {t('error.retry')}
          </button>
        </p>
      ) : current.list.length === 0 ? (
        <p className={css.hint}>{t('snapshots.empty')}</p>
      ) : (
        <ul className={css.bibList}>
          {current.list.map(snapshot => (
            <li key={snapshot.id} className={css.bibItem}>
              <div className={css.bibRow}>
                <div className={css.bibRowMain}>
                  <span className={css.snapTime} title={snapshot.createdAt}>
                    {relativeTime(t, snapshot.createdAt)}
                  </span>
                  <span className={css.snapMeta}>
                    {t('snapshots.meta', { files: snapshot.files.length, size: formatSize(snapshot.sizeBytes) })}
                  </span>
                </div>
                <button
                  type="button"
                  className={css.btn}
                  data-active={expandedId === snapshot.id || undefined}
                  aria-expanded={expandedId === snapshot.id}
                  disabled={currentContent === null}
                  onClick={() => { toggleDiff(snapshot.id) }}
                >
                  {expandedId === snapshot.id ? t('snapshots.diffClose') : t('snapshots.diff')}
                </button>
                {confirmId === snapshot.id ? (
                  <>
                    <button
                      type="button"
                      className={css.btn}
                      data-danger
                      disabled={revertingId !== null}
                      onClick={() => { revert(snapshot.id) }}
                    >
                      {revertingId === snapshot.id ? t('snapshots.reverting') : t('snapshots.confirm')}
                    </button>
                    <button
                      type="button"
                      className={css.btn}
                      disabled={revertingId !== null}
                      onClick={() => { setConfirmId(null) }}
                    >
                      {t('snapshots.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={css.btn}
                    data-danger
                    disabled={!revertable || revertingId !== null}
                    title={revertable ? t('snapshots.confirmRevert') : t('snapshots.revert')}
                    onClick={() => {
                      setActionError(null)
                      setConfirmId(snapshot.id)
                    }}
                  >
                    {t('snapshots.revert')}
                  </button>
                )}
              </div>
              {confirmId === snapshot.id && (
                <p className={css.snapConfirm} role="alert">{t('snapshots.confirmRevert')}</p>
              )}
              {expandedId === snapshot.id && (
                detail === null || detail.status === 'loading' ? (
                  <p className={css.hint}>{t('snapshots.diffLoading')}</p>
                ) : detail.status === 'error' ? (
                  <p className={css.failure} role="alert">{failureCopy(t, detail.failure)}</p>
                ) : (
                  <SnapshotDiff detail={detail} current={currentContent ?? ''} entryFile={entryFile ?? 'main.tex'} t={t} />
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
