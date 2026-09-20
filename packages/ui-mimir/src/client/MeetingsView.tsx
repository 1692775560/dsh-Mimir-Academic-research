/**
 * The meetings view: build a group-meeting (组会) pptx from the selected
 * project's wiki material. The form carries the deck title/presenter/date,
 * the four section switches (progress/experiments/figures/papers), an AI
 * illustration switch (cover + per-paper concept images, host-side when the
 * image API is configured), a paper multi-select (pre-picked to the top 5 by
 * the project's AI relevance verdicts, with a title/author/tag search box,
 * the verdict score + reason per row, and a picked-count line; unpicking all
 * means the deck has no papers section), and a figure multi-select (empty =
 * every figure with a raster sibling). Below the form a collapsible section edits
 * the image-gen API config (baseUrl/model/size/key, key masked host-side).
 * Generate calls the host's deterministic renderer (no agent round-trip);
 * the produced deck lands in `meetings/<projectId>/` and lists below with
 * download (the `/research/meeting` attachment route) and delete actions.
 * @module dsh-client-ui-mimir/client/MeetingsView
 */

import { useEffect, useMemo, useState } from 'react'
import type { FigureEntry, MeetingDeckView, MeetingInclude } from 'dsh-mimir/types'
import type {
  ResearchFailureView,
  ResearchImageGenView,
  ResearchPapersView,
  ResearchProjectSlice,
} from './controller.ts'
import type { ResearchKey } from './locales.ts'
import {
  defaultMeetingPicks,
  filterMeetingPapers,
  sortMeetingPapers,
} from './meeting-picks.ts'
import {
  failureCopy, figureUrl, formatSize, meetingDeckUrl, relativeTime, type ResearchT,
} from './view-common.ts'
import { EmptyState } from './EmptyState.tsx'
import { ViewHead } from './ViewHead.tsx'
import css from './ResearchPanel.module.css'

/** The four section switches in slide order. */
const SECTION_KEYS: readonly (keyof MeetingInclude)[] = ['progress', 'experiments', 'figures', 'papers']

/** Locale key of one section switch's label. */
const SECTION_LABELS: Record<keyof MeetingInclude, ResearchKey> = {
  progress: 'meetings.progress',
  experiments: 'meetings.experiments',
  figures: 'meetings.figures',
  papers: 'meetings.papers',
}

/** Today's date as YYYY-MM-DD, the date input's initial value. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One deck row: file name, size and mtime, a download anchor (the route
 * answers with an attachment disposition) and a delete button.
 */
function DeckRow({ projectId, file, sizeBytes, updatedAt, onDelete, busy, t }: {
  readonly projectId: string
  readonly file: string
  readonly sizeBytes: number
  readonly updatedAt: string
  readonly onDelete: (file: string) => void
  readonly busy: boolean
  readonly t: ResearchT
}) {
  return (
    <li className={css.deckRow}>
      <span className={css.deckName} title={file}>{file}</span>
      <span className={css.deckMeta}>{formatSize(sizeBytes)} · {relativeTime(t, updatedAt)}</span>
      <a className={css.btn} href={meetingDeckUrl(projectId, file)} download={file}>
        {t('meetings.download')}
      </a>
      <button
        type="button"
        className={css.btn}
        data-danger
        disabled={busy}
        onClick={() => { if (window.confirm(t('meetings.confirmDelete'))) onDelete(file) }}
      >
        {t('meetings.delete')}
      </button>
    </li>
  )
}

/**
 * @param props - the selected project, the meetings/papers/figures/image-gen
 * slices, the load/generate/delete verbs, the image-gen config verbs, and copy.
 * @returns the meetings view.
 */
export function MeetingsView({
  projectId, dir, meetings, papers, figures, imageGen,
  ensurePapers, loadFigures, loadMeetings, generateMeetingDeck, deleteMeetingDeck,
  getImageGenConfig, saveImageGenConfig, t,
}: {
  readonly projectId: string | null
  readonly dir: string | undefined
  readonly meetings: ResearchProjectSlice<readonly MeetingDeckView[]> | null
  readonly papers: ResearchPapersView
  readonly figures: ResearchProjectSlice<readonly FigureEntry[]> | null
  readonly imageGen: ResearchImageGenView
  readonly ensurePapers: () => void
  readonly loadFigures: (projectId: string, force?: boolean, quiet?: boolean) => void
  readonly loadMeetings: (projectId: string, force?: boolean) => void
  readonly generateMeetingDeck: (projectId: string, request: {
    title?: string | undefined
    presenter?: string | undefined
    date?: string | undefined
    paperIds?: readonly string[] | undefined
    figureRelPaths?: readonly string[] | undefined
    include?: Partial<MeetingInclude> | undefined
    aiIllustrations?: boolean | undefined
  }) => Promise<ResearchFailureView | null>
  readonly deleteMeetingDeck: (projectId: string, file: string) => Promise<ResearchFailureView | null>
  readonly getImageGenConfig: () => void
  readonly saveImageGenConfig: (input: {
    baseUrl?: string | undefined
    apiKey?: string | undefined
    model?: string | undefined
    size?: string | undefined
  }) => Promise<ResearchFailureView | null>
  readonly t: ResearchT
}) {
  const [title, setTitle] = useState('')
  const [presenter, setPresenter] = useState('')
  const [date, setDate] = useState(today)
  const [include, setInclude] = useState<MeetingInclude>({
    progress: true, experiments: true, figures: true, papers: true,
  })
  const [pickedPapers, setPickedPapers] = useState<ReadonlySet<string>>(new Set())
  /** Project the current picks were defaulted for (re-defaults on switch). */
  const [picksProject, setPicksProject] = useState<string | null>(null)
  const [paperQuery, setPaperQuery] = useState('')
  const [pickedFigures, setPickedFigures] = useState<ReadonlySet<string>>(new Set())
  const [aiIllustrations, setAiIllustrations] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [cfgBaseUrl, setCfgBaseUrl] = useState('')
  const [cfgModel, setCfgModel] = useState('')
  const [cfgSize, setCfgSize] = useState('')
  const [cfgApiKey, setCfgApiKey] = useState('')
  const [savingConfig, setSavingConfig] = useState(false)
  const [configFailure, setConfigFailure] = useState<ResearchFailureView | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ResearchFailureView | null>(null)

  // Warm the pick-lists the form reads (each loader skips an already-fresh
  // slice, so re-running on view mounts and project switches is cheap).
  useEffect(() => {
    if (projectId === null) return
    ensurePapers()
    loadFigures(projectId)
    loadMeetings(projectId)
  }, [projectId, ensurePapers, loadFigures, loadMeetings])

  // The image-gen config is global (not per project): warm it on tab entry.
  useEffect(() => {
    getImageGenConfig()
  }, [getImageGenConfig])

  const projectPapers = useMemo(() => projectId === null || papers.status !== 'ready'
    ? []
    : sortMeetingPapers(papers.list, projectId),
  [papers, projectId])

  // A fresh project form pre-picks the relevance top 5 (the deck's own
  // default ordering); the user's edits then stick until the next switch.
  useEffect(() => {
    if (projectId === null || papers.status !== 'ready' || picksProject === projectId) return
    setPickedPapers(new Set(defaultMeetingPicks(papers.list, projectId)))
    setPicksProject(projectId)
    setPaperQuery('')
  }, [projectId, papers, picksProject])

  const visiblePapers = useMemo(
    () => filterMeetingPapers(projectPapers, paperQuery),
    [projectPapers, paperQuery],
  )

  // The deck embeds raster siblings only (svg is skipped host-side), so the
  // pick grid offers exactly the files that can make it into the deck.
  const projectFigures = useMemo(
    () => figures !== null && figures.projectId === projectId && figures.status === 'ready'
      ? figures.list.filter(figure => /\.(png|jpe?g)$/i.test(figure.relPath))
      : [],
    [figures, projectId],
  )

  const toggle = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }

  const generate = (): void => {
    if (projectId === null || busy) return
    setBusy(true)
    setFailure(null)
    // Explicit picks always win (unpicking every paper = no papers section);
    // the ids go in the list's relevance order, so the deck reads best-first.
    void generateMeetingDeck(projectId, {
      title: title.trim() === '' ? undefined : title.trim(),
      presenter: presenter.trim() === '' ? undefined : presenter.trim(),
      date: date === '' ? undefined : date,
      paperIds: projectPapers.filter(paper => pickedPapers.has(paper.arxivId)).map(paper => paper.arxivId),
      figureRelPaths: pickedFigures.size === 0 ? undefined : [...pickedFigures],
      include,
      aiIllustrations,
    }).then((settled) => {
      setBusy(false)
      if (settled !== null) setFailure(settled)
    })
  }

  // Expanding the config fold snapshots the store's masked view into the
  // fields (the apiKey box always starts empty: empty on save = keep the
  // stored key, whose mask shows as the placeholder).
  const toggleConfig = (): void => {
    if (!configOpen) {
      setCfgBaseUrl(imageGen.baseUrl)
      setCfgModel(imageGen.model)
      setCfgSize(imageGen.size)
      setCfgApiKey('')
      setConfigFailure(null)
    }
    setConfigOpen(!configOpen)
  }

  const saveConfig = (): void => {
    if (savingConfig) return
    setSavingConfig(true)
    setConfigFailure(null)
    void saveImageGenConfig({
      ...(cfgBaseUrl.trim() === '' ? {} : { baseUrl: cfgBaseUrl.trim() }),
      ...(cfgModel.trim() === '' ? {} : { model: cfgModel.trim() }),
      ...(cfgSize.trim() === '' ? {} : { size: cfgSize.trim() }),
      ...(cfgApiKey === '' ? {} : { apiKey: cfgApiKey }),
    }).then((settled) => {
      setSavingConfig(false)
      if (settled !== null) {
        setConfigFailure(settled)
        return
      }
      setCfgApiKey('')
      setConfigOpen(false)
    })
  }

  const remove = (file: string): void => {
    if (projectId === null || busy) return
    setBusy(true)
    setFailure(null)
    void deleteMeetingDeck(projectId, file).then((settled) => {
      setBusy(false)
      if (settled !== null) setFailure(settled)
    })
  }

  if (projectId === null) {
    return (
      <section>
        <ViewHead title={t('tab.meetings')} subtitle={t('view.meetings.subtitle')} />
        <EmptyState glyph="🎞️">{t('meetings.noProject')}</EmptyState>
      </section>
    )
  }

  return (
    <section>
      <ViewHead title={t('tab.meetings')} subtitle={t('view.meetings.subtitle')}>
        <button type="button" className={css.btnPrimary} disabled={busy} onClick={generate}>
          {busy ? t('meetings.generating') : t('meetings.generate')}
        </button>
      </ViewHead>

      <div className={css.meetingForm}>
        <div className={css.meetingFormRow}>
          <input
            className={css.input}
            value={title}
            placeholder={t('meetings.titlePlaceholder')}
            aria-label={t('meetings.titlePlaceholder')}
            onChange={event => { setTitle(event.target.value) }}
          />
          <input
            className={css.input}
            value={presenter}
            placeholder={t('meetings.presenterPlaceholder')}
            aria-label={t('meetings.presenterPlaceholder')}
            onChange={event => { setPresenter(event.target.value) }}
          />
          <label className={css.meetingDate}>
            {t('meetings.dateLabel')}
            <input
              className={css.input}
              type="date"
              value={date}
              onChange={event => { setDate(event.target.value) }}
            />
          </label>
        </div>
        <div className={css.meetingFormRow} role="group" aria-label={t('meetings.sections')}>
          <span className={css.fieldLabel}>{t('meetings.sections')}</span>
          {SECTION_KEYS.map(key => (
            <label key={key} className={css.meetingCheck}>
              <input
                type="checkbox"
                checked={include[key]}
                onChange={() => { setInclude(current => ({ ...current, [key]: !current[key] })) }}
              />
              {t(SECTION_LABELS[key])}
            </label>
          ))}
        </div>
        <div className={css.meetingFormRow} role="group" aria-label={t('meetings.aiIllustrations')}>
          <label className={css.meetingCheck}>
            <input
              type="checkbox"
              checked={aiIllustrations}
              onChange={() => { setAiIllustrations(current => !current) }}
            />
            {t('meetings.aiIllustrations')}
          </label>
          {!imageGen.configured && (
            <button type="button" className={css.meetingCheckHint} onClick={toggleConfig}>
              {t('meetings.aiIllustrationsUnconfigured')}
            </button>
          )}
        </div>
      </div>

      <div className={css.imageGenPanel}>
        <button
          type="button"
          className={css.imageGenToggle}
          aria-expanded={configOpen}
          onClick={toggleConfig}
        >
          <span aria-hidden>{configOpen ? '▾' : '▸'}</span>
          {t('meetings.imageGenConfig')}
          {imageGen.configured && (
            <span className={css.imageGenBadge}>{t('meetings.imageGenConfigured')}</span>
          )}
        </button>
        {configOpen && (
          <>
            <div className={css.meetingFormRow}>
              <input
                className={css.input}
                value={cfgBaseUrl}
                placeholder={t('meetings.imageGenBaseUrl')}
                aria-label={t('meetings.imageGenBaseUrl')}
                onChange={event => { setCfgBaseUrl(event.target.value) }}
              />
              <input
                className={css.input}
                value={cfgModel}
                placeholder={t('meetings.imageGenModel')}
                aria-label={t('meetings.imageGenModel')}
                onChange={event => { setCfgModel(event.target.value) }}
              />
              <input
                className={css.input}
                value={cfgSize}
                placeholder={t('meetings.imageGenSize')}
                aria-label={t('meetings.imageGenSize')}
                onChange={event => { setCfgSize(event.target.value) }}
              />
            </div>
            <div className={css.meetingFormRow}>
              <input
                className={css.input}
                type="password"
                value={cfgApiKey}
                placeholder={imageGen.apiKeyPreview === '' ? t('meetings.imageGenApiKeyPlaceholder') : imageGen.apiKeyPreview}
                aria-label={t('meetings.imageGenApiKeyPlaceholder')}
                onChange={event => { setCfgApiKey(event.target.value) }}
              />
              <button type="button" className={css.btnPrimary} disabled={savingConfig} onClick={saveConfig}>
                {savingConfig ? t('meetings.imageGenSaving') : t('meetings.imageGenSave')}
              </button>
            </div>
            {configFailure !== null && (
              <p className={css.failure} role="alert">
                {t('meetings.imageGenSaveFailed')}：{failureCopy(t, configFailure)}
              </p>
            )}
          </>
        )}
      </div>

      {include.papers && (
        <>
          <h3 className={css.sectionTitle}>{t('meetings.pickPapers')}</h3>
          {projectPapers.length === 0 ? (
            <p className={css.hint}>{t('papers.empty')}</p>
          ) : (
            <>
              <div className={css.meetingFormRow}>
                <input
                  className={css.input}
                  value={paperQuery}
                  placeholder={t('meetings.searchPapers')}
                  aria-label={t('meetings.searchPapers')}
                  onChange={event => { setPaperQuery(event.target.value) }}
                />
                <span className={css.hint}>
                  {t('meetings.pickedCount', { picked: pickedPapers.size, total: projectPapers.length })}
                </span>
                <button
                  type="button"
                  className={css.btn}
                  onClick={() => { setPickedPapers(new Set(defaultMeetingPicks(papers.status === 'ready' ? papers.list : [], projectId))) }}
                >
                  {t('meetings.pickRecommended')}
                </button>
                <button type="button" className={css.btn} onClick={() => { setPickedPapers(new Set()) }}>
                  {t('meetings.clearPicks')}
                </button>
              </div>
              {pickedPapers.size === 0 && (
                <p className={css.hint}>{t('meetings.noPicksHint')}</p>
              )}
              {visiblePapers.length === 0 ? (
                <p className={css.hint}>{t('meetings.noMatch')}</p>
              ) : (
                <ul className={css.meetingPickList}>
                  {visiblePapers.map(paper => {
                    const verdict = paper.relevance?.[projectId]
                    const score = verdict?.score
                    const band = score === undefined ? undefined : score >= 7 ? 'high' : score >= 4 ? 'mid' : 'low'
                    const meta = [
                      paper.authors.slice(0, 2).join(', ') + (paper.authors.length > 2 ? ' et al.' : ''),
                      verdict?.reason ?? '',
                    ].filter(part => part !== '').join(' — ')
                    return (
                      <li key={paper.arxivId}>
                        <label className={css.meetingPickItem} data-picked={pickedPapers.has(paper.arxivId) || undefined}>
                          <input
                            type="checkbox"
                            checked={pickedPapers.has(paper.arxivId)}
                            onChange={() => { setPickedPapers(current => toggle(current, paper.arxivId)) }}
                          />
                          <span className={css.meetingPickBody}>
                            <span className={css.meetingPickTitleRow}>
                              <span className={css.meetingPickTitle} title={paper.title}>{paper.title}</span>
                              {score !== undefined && (
                                <span className={css.relevanceChip} data-band={band}>
                                  {score.toFixed(score % 1 === 0 ? 0 : 1)}/10
                                </span>
                              )}
                            </span>
                            {meta !== '' && (
                              <span className={css.meetingPickMeta} title={meta}>{meta}</span>
                            )}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </>
      )}

      {include.figures && (
        <>
          <h3 className={css.sectionTitle}>{t('meetings.pickFigures')}</h3>
          {projectFigures.length === 0 ? (
            <p className={css.hint}>{t('figures.empty')}</p>
          ) : (
            <ul className={css.meetingPickGrid}>
              {projectFigures.map(figure => (
                <li key={figure.relPath}>
                  <label className={css.meetingPickFigure} data-picked={pickedFigures.has(figure.relPath) || undefined}>
                    <input
                      type="checkbox"
                      checked={pickedFigures.has(figure.relPath)}
                      onChange={() => { setPickedFigures(current => toggle(current, figure.relPath)) }}
                    />
                    <img src={figureUrl(projectId, figure.relPath, dir)} alt={figure.caption ?? figure.name} loading="lazy" />
                    <span className={css.meetingPickTitle} title={figure.relPath}>{figure.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {failure !== null && (
        <p className={css.failure} role="alert">
          {t('meetings.generateFailed')}：{failureCopy(t, failure)}
        </p>
      )}

      <h3 className={css.sectionTitle}>{t('meetings.decks')}</h3>
      {meetings === null || meetings.status === 'loading' ? (
        <p className={css.hint}>{t('meetings.loading')}</p>
      ) : meetings.status === 'error' ? (
        <p className={css.failure} role="alert">
          {t('error.meetings')}：{failureCopy(t, meetings.failure)}
          <button type="button" className={css.retry} onClick={() => { loadMeetings(projectId, true) }}>
            {t('projects.retry')}
          </button>
        </p>
      ) : meetings.list.length === 0 ? (
        <EmptyState glyph="🎞️">{t('meetings.empty')}</EmptyState>
      ) : (
        <ul className={css.deckList}>
          {meetings.list.map(deck => (
            <DeckRow
              key={deck.file}
              projectId={projectId}
              file={deck.file}
              sizeBytes={deck.sizeBytes}
              updatedAt={deck.updatedAt}
              onDelete={remove}
              busy={busy}
              t={t}
            />
          ))}
        </ul>
      )}

      <p className={css.hint}>{t('meetings.skillHint')}</p>
    </section>
  )
}
