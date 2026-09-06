/**
 * The overview's data section: wiki backup and migration. The header line
 * reports the host's scheduled-backup knobs and on-disk count (hidden until
 * `listBackups` settles). Export downloads
 * the whole wiki as one dated JSON snapshot; import walks a three-step flow
 * — pick a file, review its summary (per-table row counts and the export
 * timestamp), then choose merge (existing keys are skipped, never
 * overwritten) or replace (a red-armed second confirm, since it wipes all
 * six tables first) — and ends with the per-table imported/skipped counts.
 * A successful import re-fetches every loaded slice host-side.
 * @module dsh-client-ui-mimir/client/DataSection
 */

import { useRef, useState } from 'react'
import type { ResearchBackupStatusView, ResearchImportWikiMode, ResearchWikiSnapshot } from 'dsh-mimir/types'
import type { ResearchFailureView } from './controller.ts'
import { failureCopy, type ResearchT } from './view-common.ts'
import {
  wikiExportFilename, wikiSnapshotSummary, type WikiSnapshotSummary,
} from './wiki-transfer.ts'
import css from './ResearchPanel.module.css'

/** Per-table imported/skipped counts returned by a settled import. */
interface ImportCounts {
  readonly imported: Record<string, number>
  readonly skipped: Record<string, number>
}

/** Sum one count map (the totals line). */
function totalOf(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

/**
 * @param props - the export/import inject verbs and copy.
 * @returns the data card: two actions, then the pending-import summary or
 * the settled result.
 */
export function DataSection({ backup, exportWiki, importWiki, t }: {
  /** Scheduled-backup status; null hides the line (not loaded yet). */
  readonly backup: ResearchBackupStatusView | null
  readonly exportWiki: () => Promise<ResearchWikiSnapshot | ResearchFailureView>
  readonly importWiki: (
    snapshot: unknown,
    mode: ResearchImportWikiMode,
    confirmReplace: boolean,
  ) => Promise<ImportCounts | ResearchFailureView>
  readonly t: ResearchT
}) {
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The parsed import candidate awaiting the user's mode choice.
  const [pending, setPending] = useState<{ snapshot: unknown; summary: WikiSnapshotSummary } | null>(null)
  // True after the user picked replace: the red warning confirm step.
  const [replaceArmed, setReplaceArmed] = useState(false)
  const [result, setResult] = useState<ImportCounts | null>(null)

  const onExport = (): void => {
    setError(null)
    setResult(null)
    setBusy(true)
    void exportWiki().then((outcome) => {
      setBusy(false)
      if ('code' in outcome) {
        setError(`${t('overview.exportFailed')}：${failureCopy(t, outcome)}`)
        return
      }
      const blob = new Blob([JSON.stringify(outcome, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = wikiExportFilename(new Date())
      anchor.click()
      URL.revokeObjectURL(url)
    })
  }

  const onFile = (file: File): void => {
    setError(null)
    setResult(null)
    setReplaceArmed(false)
    void file.text().then((text) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        setError(t('overview.importInvalid'))
        return
      }
      const summary = wikiSnapshotSummary(parsed)
      if (summary === null) {
        setError(t('overview.importInvalid'))
        return
      }
      setPending({ snapshot: parsed, summary })
    })
  }

  const runImport = (mode: ResearchImportWikiMode): void => {
    if (pending === null) return
    setError(null)
    setBusy(true)
    void importWiki(pending.snapshot, mode, mode === 'replace').then((outcome) => {
      setBusy(false)
      setPending(null)
      setReplaceArmed(false)
      if ('code' in outcome) {
        setError(`${t('overview.importFailed')}：${failureCopy(t, outcome)}`)
        return
      }
      setResult(outcome)
    })
  }

  return (
    <div className={css.dataSection}>
      <h3 className={css.sectionTitle}>{t('overview.data')}</h3>
      {backup !== null && (
        <p className={css.hint}>
          {t('overview.backup')}
          ：{backup.enabled
            ? `${t('overview.backupEvery')} ${backup.intervalMinutes} ${t('overview.backupMinutes')} · ${t('overview.backupKeep')} ${backup.keep} · ${backup.count} ${t('overview.backupStored')}`
            : t('overview.backupDisabled')}
        </p>
      )}
      <div className={css.dataActions}>
        <button type="button" className={css.btn} disabled={busy} onClick={onExport}>
          {t('overview.exportWiki')}
        </button>
        <button
          type="button"
          className={css.btn}
          disabled={busy}
          onClick={() => { fileInput.current?.click() }}
        >
          {t('overview.importWiki')}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) onFile(file)
          }}
        />
      </div>
      {error !== null && <p className={css.failure} role="alert">{error}</p>}
      {pending !== null && (
        <div className={css.dataSummary}>
          <p className={css.hint}>
            {t('overview.exportedAt')} {new Date(pending.summary.exportedAt).toLocaleString()}
          </p>
          <ul className={css.artifactList}>
            {pending.summary.tables.map(table => (
              <li key={table.name}>{t(`wikiTable.${table.name}` as Parameters<ResearchT>[0])} × {table.count}</li>
            ))}
          </ul>
          {replaceArmed ? (
            <>
              <p className={css.dataWarning} role="alert">{t('overview.replaceWarning')}</p>
              <div className={css.dataActions}>
                <button
                  type="button"
                  className={css.btn}
                  data-danger
                  disabled={busy}
                  onClick={() => { runImport('replace') }}
                >
                  {t('overview.confirmReplace')}
                </button>
                <button
                  type="button"
                  className={css.btn}
                  disabled={busy}
                  onClick={() => { setReplaceArmed(false) }}
                >
                  {t('overview.cancel')}
                </button>
              </div>
            </>
          ) : (
            <div className={css.dataActions}>
              <button
                type="button"
                className={css.btnPrimary}
                disabled={busy}
                onClick={() => { runImport('merge') }}
              >
                {t('overview.importMerge')}
              </button>
              <button
                type="button"
                className={css.btn}
                data-danger
                disabled={busy}
                onClick={() => { setReplaceArmed(true) }}
              >
                {t('overview.importReplace')}
              </button>
              <button
                type="button"
                className={css.btn}
                disabled={busy}
                onClick={() => { setPending(null) }}
              >
                {t('overview.cancel')}
              </button>
            </div>
          )}
        </div>
      )}
      {result !== null && (
        <p className={css.hint} role="status">
          {t('overview.importDone')}
          ：{t('overview.imported')} {totalOf(result.imported)} · {t('overview.skipped')} {totalOf(result.skipped)}
        </p>
      )}
    </div>
  )
}
