/**
 * The figures view: a thumbnail grid of the selected project's paper figures,
 * served through the `/research/figure` route. Files sharing one stem
 * (`figures/foo.png` + `figures/foo.svg`) are format siblings of ONE figure
 * and render as one card (see `figure-groups.ts`): the card previews the best
 * raster/SVG sibling, badges every format, and its actions act on the
 * LaTeX-preferred sibling (PDF first, then raster). Hovering a card reveals
 * its operations — insert the standard figure block into the paper's
 * `main.tex` (or jump to the existing reference), copy the LaTeX figure
 * block, rename the group (the host rewrites `.tex` references), edit the
 * caption, hand the figure to the agent for AI naming/captioning, delete the
 * files — and the view head carries the upload button (POST
 * `/research/figure-upload`) plus the forced rescan. Cards show the
 * wiki-recorded caption and a linked-experiment badge when the figures
 * metadata table knows the stem. Image files can also be dragged anywhere
 * onto the view: a dashed overlay shows while hovering, the drop reuses the
 * upload channel, and files outside the accept list are reported, not
 * silently ignored.
 * @module dsh-client-ui-mimir/client/FiguresView
 */

import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import type { ExperimentRecord, FigureEntry } from 'dsh-mimir/types'
import type { ResearchFailureView, ResearchProjectSlice } from './controller.ts'
import { buildFigureOrganizePrompt } from './figure-ai.ts'
import { groupFigures, type FigureGroup } from './figure-groups.ts'
import {
  failureCopy, FIGURE_ACCEPT_EXTENSIONS, figureUrl, filterDropFiles, formatSize, type ResearchT,
} from './view-common.ts'
import { EmptyState } from './EmptyState.tsx'
import { ViewHead } from './ViewHead.tsx'
import css from './ResearchPanel.module.css'

/** The LaTeX figure block one card's copy button puts on the clipboard. */
function latexOf(entry: FigureEntry, caption: string | undefined): string {
  const label = entry.name.replace(/\.[^.]+$/, '')
  return `\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${entry.relPath}}\n  \\caption{${caption ?? ''}}\n  \\label{fig:${label}}\n\\end{figure}`
}

/** How long the copied confirmation replaces the copy button's label. */
const COPIED_FEEDBACK_MS = 1500
/** Poll interval while an AI organize request is in flight. */
const ORGANIZE_POLL_MS = 5000
/** How long an AI-organize poll runs before its pending marker gives up. */
const ORGANIZE_TIMEOUT_MS = 120_000

/** Change-detection signature of one figure list (the AI-organize poll's anchor). */
function figuresSignature(list: readonly FigureEntry[]): string {
  return list.map(entry => `${entry.relPath}${entry.caption ?? ''}`).join('|')
}

/**
 * One card's inline editor: the group's file-name stem (every sibling keeps
 * its own extension) and its caption. Saving renames through the host (which
 * rewrites `.tex` references) and/or upserts the caption; failures surface
 * through the view's error line.
 */
function FigureEditor({ group, onSave, onCancel, saving, t }: {
  readonly group: FigureGroup
  readonly onSave: (stem: string, caption: string) => void
  readonly onCancel: () => void
  readonly saving: boolean
  readonly t: ResearchT
}) {
  const [stem, setStem] = useState(group.name)
  const [caption, setCaption] = useState(group.caption ?? '')
  return (
    <div className={css.figureEditor}>
      <input
        className={css.input}
        value={stem}
        placeholder={t('figures.renamePlaceholder')}
        aria-label={t('figures.rename')}
        onChange={event => { setStem(event.target.value) }}
      />
      <input
        className={css.input}
        value={caption}
        placeholder={t('figures.captionPlaceholder')}
        aria-label={t('figures.captionEdit')}
        onChange={event => { setCaption(event.target.value) }}
      />
      <div className={css.figureEditorFoot}>
        <button
          type="button"
          className={css.btnPrimary}
          disabled={saving || stem.trim() === ''}
          onClick={() => { onSave(stem.trim(), caption.trim()) }}
        >
          {t('figures.captionSave')}
        </button>
        <button type="button" className={css.btn} disabled={saving} onClick={onCancel}>
          {t('figures.editCancel')}
        </button>
      </div>
    </div>
  )
}

/**
 * @param props - the figures slice, the selected project and its paperDir,
 * the rescan/upload/delete/rename/caption verbs, the AI-organize channel, and
 * copy.
 * @returns the thumbnail grid plus the lightbox overlay.
 */
export function FiguresView({
  figures, experiments, projectId, projectTitle, dir,
  loadFigures, uploadFigures, deleteFigure, renameFigure, updateFigure, requestFigureOrganize,
  insertFigure, t,
}: {
  readonly figures: ResearchProjectSlice<readonly FigureEntry[]> | null
  /** Experiment list of the same project, used to name linked-experiment badges. */
  readonly experiments: ResearchProjectSlice<readonly ExperimentRecord[]> | null
  readonly projectId: string | null
  /** The selected project's title, for the AI-organize prompt's context. */
  readonly projectTitle: string
  readonly dir: string | undefined
  readonly loadFigures: (projectId: string, force?: boolean, quiet?: boolean) => void
  readonly uploadFigures: (
    projectId: string,
    dir: string | undefined,
    files: readonly File[],
    onProgress?: (done: number, total: number) => void,
  ) => Promise<void>
  readonly deleteFigure: (projectId: string, relPath: string) => Promise<ResearchFailureView | null>
  readonly renameFigure: (projectId: string, relPath: string, newName: string) => Promise<ResearchFailureView | null>
  readonly updateFigure: (projectId: string, relPath: string, caption: string) => Promise<ResearchFailureView | null>
  /** Hand one assembled figure-organization prompt to the current session's agent. */
  readonly requestFigureOrganize: (prompt: string) => Promise<void>
  /** Insert one card's figure block into the paper (or jump to its reference). */
  readonly insertFigure: (entry: FigureEntry) => Promise<void>
  readonly t: ResearchT
}) {
  const [preview, setPreview] = useState<FigureEntry | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The card whose insert is in flight (its button reads "插入中…").
  const [insertingPath, setInsertingPath] = useState<string | null>(null)
  // The group stem whose inline editor is open.
  const [editingStem, setEditingStem] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  // The in-flight AI organize request: the list signature it started from and
  // its start time. A changed signature means the agent's writes landed.
  const [organizing, setOrganizing] = useState<{ anchor: string; startedAt: number } | null>(null)
  // True while a file drag hovers the view (drives the dashed drop overlay).
  const [dragActive, setDragActive] = useState(false)
  // Enter/leave fire per child element; the depth counter keeps the overlay
  // from flickering as the pointer crosses cards.
  const dragDepth = useRef(0)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // Poll the figure list while an AI organize request is in flight.
  // Cancel a pending copied-path reset on unmount.
  useEffect(() => () => {
    if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
  }, [])

  useEffect(() => {
    if (organizing === null || projectId === null) return
    const timer = setInterval(() => { loadFigures(projectId, true, true) }, ORGANIZE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [organizing === null, projectId, loadFigures])

  // Retire the organize marker once the list changed or the request timed out.
  const listSignature = figures === null || figures.status !== 'ready' ? '' : figuresSignature(figures.list)
  useEffect(() => {
    if (organizing === null || listSignature === '') return
    if (listSignature !== organizing.anchor || Date.now() - organizing.startedAt > ORGANIZE_TIMEOUT_MS) {
      setOrganizing(null)
    }
  }, [listSignature, organizing])

  if (projectId === null) {
    return <EmptyState glyph="🖼️">{t('figures.noProject')}</EmptyState>
  }
  const url = (entry: FigureEntry): string => figureUrl(projectId, entry.relPath, dir)
  /** Resolve one linked experiment id to its display name (id as fallback). */
  const experimentNameOf = (id: string): string => {
    if (experiments !== null && experiments.status === 'ready') {
      const found = experiments.list.find(record => record.id === id)
      if (found !== undefined) return found.name
    }
    return id
  }

  const copyLatex = (group: FigureGroup): void => {
    void navigator.clipboard.writeText(latexOf(group.insert, group.caption)).then(() => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
      setCopiedPath(group.stem)
      copiedTimerRef.current = setTimeout(() => {
        setCopiedPath(current => (current === group.stem ? null : current))
      }, COPIED_FEEDBACK_MS)
    })
  }

  /** Delete every sibling of one group, stopping at the first failure. */
  const removeGroup = (group: FigureGroup): void => {
    if (!window.confirm(t('figures.confirmDelete'))) return
    setActionError(null)
    void (async (): Promise<void> => {
      for (const entry of group.entries) {
        const failure = await deleteFigure(projectId, entry.relPath)
        if (failure !== null) {
          setActionError(`${t('figures.deleteFailed')}：${failure.message}`)
          return
        }
      }
    })()
  }

  /** Save one group's inline edit: rename every sibling, then set the caption. */
  const saveGroupEdit = (group: FigureGroup, stem: string, caption: string): void => {
    if (savingEdit) return
    setSavingEdit(true)
    setActionError(null)
    void (async (): Promise<void> => {
      if (stem !== group.name) {
        for (const entry of group.entries) {
          const ext = entry.name.slice(entry.name.lastIndexOf('.'))
          const failure = await renameFigure(projectId, entry.relPath, `${stem}${ext}`)
          if (failure !== null) {
            setActionError(`${t('figures.renameFailed')}：${failure.message}`)
            return
          }
        }
      }
      if (caption !== (group.caption ?? '')) {
        for (const entry of group.entries) {
          const failure = await updateFigure(projectId, entry.relPath, caption)
          if (failure !== null) {
            setActionError(`${t('figures.captionFailed')}：${failure.message}`)
            return
          }
        }
      }
      setEditingStem(null)
    })().finally(() => { setSavingEdit(false) })
  }

  /** Hand one group to the current session's agent for naming + captioning. */
  const organizeWithAi = (group: FigureGroup): void => {
    if (organizing !== null) return
    setActionError(null)
    setOrganizing({ anchor: listSignature, startedAt: Date.now() })
    void requestFigureOrganize(buildFigureOrganizePrompt({
      entry: group.insert,
      siblings: group.formats,
      projectId,
      projectTitle,
      dir,
    }))
  }

  /** Insert one card's block into the paper; failures arrive as toasts. */
  const runInsert = (entry: FigureEntry): void => {
    if (insertingPath !== null) return
    setInsertingPath(entry.relPath)
    void insertFigure(entry).finally(() => { setInsertingPath(null) })
  }

  const pickFiles = (files: readonly File[]): void => {
    if (files.length === 0 || upload !== null) return
    setActionError(null)
    setUpload({ done: 0, total: files.length })
    void uploadFigures(projectId, dir, files, (done, total) => { setUpload({ done, total }) })
      .catch((error: unknown) => {
        setActionError(`${t('figures.uploadFailed')}：${error instanceof Error ? error.message : 'upload failed'}`)
      })
      .finally(() => { setUpload(null) })
  }

  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    // The host app runs its own page-level file-drop overlay; keep it off
    // while a file drag is over the figures view.
    event.stopPropagation()
    dragDepth.current += 1
    setDragActive(true)
  }
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    // preventDefault opts the view into being a drop target.
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setDragActive(false)
    const { accepted, rejected } = filterDropFiles(
      [...event.dataTransfer.files],
      FIGURE_ACCEPT_EXTENSIONS,
    )
    pickFiles(accepted)
    // After pickFiles (which clears the banner): the rejection note wins.
    if (rejected.length > 0) {
      setActionError(`${t('figures.dropRejected')}：${rejected.map(file => file.name).join('、')}`)
    }
  }

  return (
    <div
      className={css.figures}
      data-drag-active={dragActive || undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && (
        <div className={css.figuresDropOverlay} aria-hidden>
          <span>{t('figures.dropHint')}</span>
        </div>
      )}
      <ViewHead title={t('tab.figures')} subtitle={t('view.figures.subtitle')}>
        <button
          type="button"
          className={css.btnPrimary}
          disabled={upload !== null}
          onClick={() => { fileInput.current?.click() }}
        >
          {upload === null ? t('figures.upload') : `${t('figures.uploading')} ${upload.done}/${upload.total}`}
        </button>
        <button type="button" className={css.btn} onClick={() => { loadFigures(projectId, true) }}>
          {t('figures.refresh')}
        </button>
      </ViewHead>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={FIGURE_ACCEPT_EXTENSIONS.join(',')}
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          pickFiles(files)
        }}
      />
      {actionError !== null && (
        <p className={css.failure} role="alert">{actionError}</p>
      )}
      {figures === null || figures.status === 'loading' ? (
        <p className={css.hint}>{t('figures.loading')}</p>
      ) : figures.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.figures')}：{failureCopy(t, figures.failure)}
          <button type="button" className={css.btn} onClick={() => { loadFigures(projectId, true) }}>
            {t('error.retry')}
          </button>
        </p>
      ) : figures.list.length === 0 ? (
        <EmptyState glyph="🖼️">{t('figures.empty')}</EmptyState>
      ) : (
        <div className={css.figuresGrid}>
          {groupFigures(figures.list).map((group) => {
            const isPdfOnly = group.preview === null
            return (
              <div key={group.stem} className={css.figureCard}>
                <button
                  type="button"
                  className={css.figurePreview}
                  title={isPdfOnly ? t('figures.openPdf') : undefined}
                  onClick={() => {
                    if (group.preview === null) window.open(url(group.insert), '_blank')
                    else setPreview(group.preview)
                  }}
                >
                  {group.preview === null
                    ? <span className={css.figureBadge}>{t('figures.pdfBadge')}</span>
                    : <img className={css.figureThumb} src={url(group.preview)} alt={group.name} loading="lazy" />}
                </button>
                <span className={css.figureName} title={group.entries.map(entry => entry.relPath).join('\n')}>
                  {group.name}
                </span>
                <span className={css.figureFormats}>
                  {group.formats.map(format => (
                    <span key={format} className={css.figureFormatBadge}>{format}</span>
                  ))}
                  <span className={css.figureSize}>{formatSize(group.sizeBytes)}</span>
                </span>
                {group.caption !== undefined && (
                  <span className={css.figureCaption} title={group.caption}>{group.caption}</span>
                )}
                {group.experimentId !== undefined && (
                  <span className={css.figureExpBadge}>⚡ {experimentNameOf(group.experimentId)}</span>
                )}
                {editingStem === group.stem ? (
                  <FigureEditor
                    group={group}
                    saving={savingEdit}
                    onSave={(stem, caption) => { saveGroupEdit(group, stem, caption) }}
                    onCancel={() => { setEditingStem(null) }}
                    t={t}
                  />
                ) : (
                  <div className={css.figureActions}>
                    <button
                      type="button"
                      className={css.figureAction}
                      disabled={insertingPath !== null}
                      onClick={() => { runInsert(group.insert) }}
                    >
                      {insertingPath === group.insert.relPath ? t('figures.inserting') : t('figures.insert')}
                    </button>
                    <button
                      type="button"
                      className={css.figureAction}
                      data-copied={copiedPath === group.stem || undefined}
                      onClick={() => { copyLatex(group) }}
                    >
                      {copiedPath === group.stem ? t('figures.copied') : t('figures.copyLatex')}
                    </button>
                    <button
                      type="button"
                      className={css.figureAction}
                      onClick={() => { setEditingStem(group.stem) }}
                    >
                      {t('figures.rename')}
                    </button>
                    <button
                      type="button"
                      className={css.figureAction}
                      disabled={organizing !== null}
                      onClick={() => { organizeWithAi(group) }}
                    >
                      {organizing === null ? t('figures.organizeAi') : t('figures.organizing')}
                    </button>
                    <button
                      type="button"
                      className={css.figureAction}
                      data-danger
                      onClick={() => { removeGroup(group) }}
                    >
                      {t('figures.delete')}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {preview !== null && (
        <button
          type="button"
          className={css.figureLightbox}
          aria-label={t('figures.closePreview')}
          // Focus the lightbox on open so Esc/Enter reach it; Esc closes only
          // the lightbox (stopPropagation keeps the panel's Esc-to-close).
          ref={(element) => { element?.focus() }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            event.preventDefault()
            setPreview(null)
          }}
          onClick={() => { setPreview(null) }}
        >
          <img src={url(preview)} alt={preview.name} />
        </button>
      )}
    </div>
  )
}
