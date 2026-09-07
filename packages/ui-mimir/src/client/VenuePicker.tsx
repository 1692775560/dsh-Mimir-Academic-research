/**
 * The paper view's venue picker: a header chip naming the project's target
 * venue, opening a popover with the built-in registry (grouped by series),
 * the custom-kit upload, and the "format to venue" handoff button. Applying
 * a venue writes `template/TEMPLATE.md` into the paper directory host-side;
 * the handoff button then sends the assembled re-layout prompt to the
 * current session's agent.
 * @module dsh-client-ui-mimir/client/VenuePicker
 */

import { useEffect, useRef, useState } from 'react'
import type { VenueTemplateView, VenueView } from 'dsh-mimir/types'
import type { ResearchFailureView, ResearchVenueTemplatesView } from './controller.ts'
import type { ResearchT } from './view-common.ts'
import { buildVenueFormatPrompt } from './venue-format.ts'
import css from './ResearchPanel.module.css'

/** Group one registry list by its `series` field, declaration order kept. */
function groupBySeries(templates: readonly VenueTemplateView[]): ReadonlyArray<{ series: string; list: VenueTemplateView[] }> {
  const groups: Array<{ series: string; list: VenueTemplateView[] }> = []
  for (const template of templates) {
    const found = groups.find(group => group.series === template.series)
    if (found === undefined) groups.push({ series: template.series, list: [template] })
    else found.list.push(template)
  }
  return groups
}

/**
 * @param props - the selected project (id/title/dir/venue), the registry
 * slice, the apply/clear/upload verbs, the format handoff, and copy.
 * @returns the header chip plus its popover.
 */
export function VenuePicker({
  projectId, projectTitle, dir, venue, venueTemplates,
  ensureVenueTemplates, applyVenueTemplate, clearVenueTemplate, uploadTemplateFiles, requestVenueFormat, t,
}: {
  readonly projectId: string
  readonly projectTitle: string
  readonly dir: string | undefined
  readonly venue: VenueView | undefined
  readonly venueTemplates: ResearchVenueTemplatesView
  readonly ensureVenueTemplates: () => void
  readonly applyVenueTemplate: (
    projectId: string,
    options: { templateId?: string | undefined; customName?: string | undefined },
  ) => Promise<ResearchFailureView | null>
  readonly clearVenueTemplate: (projectId: string) => Promise<ResearchFailureView | null>
  readonly uploadTemplateFiles: (projectId: string, dir: string | undefined, files: readonly File[]) => Promise<void>
  readonly requestVenueFormat: (prompt: string) => Promise<void>
  readonly t: ResearchT
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [customName, setCustomName] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Uploaded kit file names waiting for a custom name to apply under.
  const [uploaded, setUploaded] = useState<readonly string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) ensureVenueTemplates()
  }, [open, ensureVenueTemplates])

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown) }
  }, [open])

  const run = async (action: () => Promise<ResearchFailureView | null>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const failure = await action()
      if (failure !== null) setError(failure.message)
      else setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const onUpload = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await uploadTemplateFiles(projectId, dir, files)
      setUploaded(files.map(file => file.name))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      if (fileRef.current !== null) fileRef.current.value = ''
    }
  }

  const formatToVenue = async (): Promise<void> => {
    if (venue === undefined) return
    setOpen(false)
    await requestVenueFormat(buildVenueFormatPrompt({
      projectTitle,
      venueName: venue.name,
      paperDir: dir ?? 'paper',
    }))
  }

  const groups = groupBySeries(venueTemplates.list)
  return (
    <div ref={rootRef} className={css.venuePicker}>
      <button
        type="button"
        className={css.venueChip}
        data-set={venue !== undefined || undefined}
        aria-expanded={open}
        title={venue === undefined ? t('venue.pick') : `${t('venue.current')}：${venue.name}`}
        onClick={() => { setOpen(previous => !previous) }}
      >
        {venue === undefined ? t('venue.pick') : venue.name}
      </button>
      {venue !== undefined && (
        <button
          type="button"
          className={css.btn}
          disabled={busy}
          title={t('venue.formatHint')}
          onClick={() => { void formatToVenue() }}
        >
          {t('venue.format')}
        </button>
      )}
      {open && (
        <div className={css.venuePopover} role="dialog" aria-label={t('venue.pick')}>
          <p className={css.venuePopoverTitle}>{t('venue.builtins')}</p>
          {venueTemplates.status === 'loading' && <p className={css.hint}>{t('venue.loading')}</p>}
          {venueTemplates.status === 'error' && <p className={css.failure}>{venueTemplates.failure?.message}</p>}
          {groups.map(group => (
            <div key={group.series} className={css.venueGroup}>
              <p className={css.venueGroupTitle}>{group.series}</p>
              {group.list.map(template => (
                <button
                  key={template.id}
                  type="button"
                  className={css.venueOption}
                  data-active={venue?.id === template.id || undefined}
                  disabled={busy}
                  title={template.url}
                  onClick={() => { void run(() => applyVenueTemplate(projectId, { templateId: template.id })) }}
                >
                  {template.name}
                </button>
              ))}
            </div>
          ))}
          <p className={css.venuePopoverTitle}>{t('venue.custom')}</p>
          <p className={css.hint}>{t('venue.customHint')}</p>
          <div className={css.venueCustomRow}>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".cls,.sty,.tex,.bst,.bbx,.cbx,.clo,.def,.cfg,.md,.txt,.pdf"
              className={css.venueFileInput}
              disabled={busy}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])]
                void onUpload(files)
              }}
            />
          </div>
          {uploaded.length > 0 && (
            <div className={css.venueCustomRow}>
              <input
                className={css.input}
                value={customName}
                placeholder={t('venue.customNamePlaceholder')}
                aria-label={t('venue.customNamePlaceholder')}
                onChange={event => { setCustomName(event.target.value) }}
              />
              <button
                type="button"
                className={css.btnPrimary}
                disabled={busy || customName.trim() === ''}
                onClick={() => { void run(() => applyVenueTemplate(projectId, { customName: customName.trim() })) }}
              >
                {t('venue.applyCustom')}
              </button>
            </div>
          )}
          {uploaded.length > 0 && (
            <p className={css.hint}>{t('venue.uploadedFiles')}：{uploaded.join('，')}</p>
          )}
          {venue !== undefined && (
            <button
              type="button"
              className={css.venueClear}
              disabled={busy}
              onClick={() => { void run(() => clearVenueTemplate(projectId)) }}
            >
              {t('venue.clear')}
            </button>
          )}
          {error !== null && <p className={css.failure} role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
